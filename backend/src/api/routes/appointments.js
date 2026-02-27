const logger = require('../../lib/logger');
const express = require('express');
const router = express.Router();
const { pool } = require('../../../db');
const { appointmentRepository, leadRepository, notificationRepository, companyRepository } = require('../../../db/repositories');
const { logLeadActivity } = require('../../../services/activityLogger');
const { getAvailability } = require('../../../services/availabilityService');
const reminderWorker = require('../../../services/appointmentReminderWorker');
const googleCalendarService = require('../../services/googleCalendarService');
const { createNotification } = require('../../services/notificationService');
const {
  createAppointmentSchema,
  updateAppointmentSchema,
  rescheduleSchema,
  statusSchema,
  listAppointmentsSchema,
  upcomingSchema,
  cancelSchema,
} = require('../validators/appointmentSchemas');
const { errorJson } = require('../middleware/errors');

function validationError(res, parsed, debugCtx) {
  const err = parsed.error.flatten();
  const fieldMsgs = Object.entries(err.fieldErrors ?? {})
    .map(([f, msgs]) => `${f}: ${(msgs || []).join(', ')}`)
    .filter(Boolean);
  const msg = err.formErrors?.[0] || fieldMsgs.join('; ') || 'Validation failed';
  if (process.env.NODE_ENV !== 'production') {
    console.debug('[appointments] validation failed:', { msg, fields: Object.keys(err.fieldErrors ?? {}), ...debugCtx });
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
  logger.error(`[appointments] ${tag}:`, { message: err.message, code: err.code, detail: err.detail, ...extra });
}

async function createAppointmentHandler(req, res, overrideLeadId) {
  try {
    const body = overrideLeadId ? { ...req.body, lead_id: overrideLeadId, leadId: overrideLeadId } : req.body;
    const parsed = createAppointmentSchema.safeParse(body);
    if (!parsed.success) return validationError(res, parsed, { route: 'POST create', bodyKeys: Object.keys(req.body || {}) });

    const { lead_id, title, appointment_type, status, start_at, end_at, timezone, notes, source, reminder_minutes_before } = parsed.data;
    const companyId = req.tenantId;

    const lead = await leadRepository.findById(companyId, lead_id);
    if (!lead) return errorJson(res, 404, 'NOT_FOUND', 'Lead not found or does not belong to your company');

    const derivedTitle = title || `${(appointment_type || 'call').replace(/_/g, ' ')} - ${lead.name || lead.channel || 'Lead'}`;

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

    const actorType = req.user?.role === 'admin' ? 'admin' : 'user';
    logLeadActivity({
      companyId, leadId: lead_id, eventType: 'appointment_created', actorType, actorUserId: req.user?.id,
      metadata: { appointmentId: appointment.id, type: appointment_type, message: `Appointment scheduled: ${derivedTitle} on ${fmtTime(start_at)}` },
    }).catch(() => {});

    const leadName = lead.name || lead.channel || 'Lead';
    notificationRepository.create(companyId, {
      leadId: lead_id, type: 'appointment', title: 'Appointment scheduled',
      body: `${derivedTitle} with ${leadName} on ${fmtTime(start_at)}`,
      url: `/inbox/${lead_id}`,
    }).catch(() => {});
    createNotification(companyId, 'booking_confirmed', 'Call Booked', `Call with ${leadName} scheduled`, lead_id).catch(() => {});

    if ((status || appointment.status) === 'scheduled') {
      const warmingService = require('../../services/warmingService');
      warmingService.enrollLead(lead_id, companyId, 'call_booked').catch((err) => logger.error('[appointments] warming enroll error:', err.message));
    }

    if (companyId) {
      googleCalendarService.syncNewAppointmentToGoogle(companyId, appointment, lead).catch((err) =>
        logger.error('[appointments] Google sync:', err.message)
      );
    }

    res.status(201).json(appointment);
  } catch (err) {
    logDbError('create', err);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to create appointment');
  }
}

// POST /api/appointments
router.post('/', (req, res) => createAppointmentHandler(req, res, null));

// GET /api/appointments
router.get('/', async (req, res) => {
  try {
    const parsed = listAppointmentsSchema.safeParse(req.query);
    if (!parsed.success) return validationError(res, parsed, { route: 'GET /', queryKeys: Object.keys(req.query || {}) });

    const { from, to, status, appointment_type, source, lead_id, q, limit, offset } = parsed.data;
    const companyId = req.tenantId;
    const opts = { from, to, status, appointmentType: appointment_type, source, leadId: lead_id, q, limit, offset };

    const [items, total] = await Promise.all([
      appointmentRepository.list(companyId, opts),
      appointmentRepository.count(companyId, opts),
    ]);

    res.json({ items, total, range: { from: from ?? null, to: to ?? null } });
  } catch (err) {
    logDbError('list', err, { query: req.query, tenantId: req.tenantId });
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to list appointments');
  }
});

// Static sub-routes BEFORE /:id
router.get('/upcoming', async (req, res) => {
  try {
    const parsed = upcomingSchema.safeParse(req.query);
    if (!parsed.success) return validationError(res, parsed, { route: 'GET /upcoming' });

    const items = await appointmentRepository.upcoming(req.tenantId, {
      limit: parsed.data.limit,
      withinDays: parsed.data.within_days,
    });
    res.json({ items });
  } catch (err) {
    logDbError('upcoming', err, { tenantId: req.tenantId });
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to fetch upcoming appointments');
  }
});

router.get('/availability', async (req, res) => {
  try {
    const from = req.query.from || req.query.fromDate;
    const to = req.query.to || req.query.toDate;
    const appointmentType = req.query.type || req.query.appointmentType || req.query.appointment_type;
    const companyId = req.tenantId;

    const result = await getAvailability(companyId, {
      from: from || undefined,
      to: to || undefined,
      appointmentType: appointmentType || undefined,
    });
    res.json(result);
  } catch (err) {
    logDbError('availability', err, { tenantId: req.tenantId, query: req.query });
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to compute availability');
  }
});

router.post('/reminders/run', async (req, res) => {
  try {
    const count = await reminderWorker.runOnce();
    res.json({ success: true, remindersProcessed: count ?? 0 });
  } catch (err) {
    logDbError('reminders/run', err);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to run reminders');
  }
});

// Dynamic /:id routes AFTER static routes
router.get('/:id', async (req, res) => {
  try {
    const appointment = await appointmentRepository.findById(req.tenantId, req.params.id);
    if (!appointment) return errorJson(res, 404, 'NOT_FOUND', 'Appointment not found');
    res.json(appointment);
  } catch (err) {
    logDbError('get', err, { id: req.params.id });
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to fetch appointment');
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const parsed = updateAppointmentSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed, { route: 'PATCH /:id', bodyKeys: Object.keys(req.body || {}) });

    const companyId = req.tenantId;
    const existing = await appointmentRepository.findById(companyId, req.params.id);
    if (!existing) return errorJson(res, 404, 'NOT_FOUND', 'Appointment not found');

    if ((parsed.data.start_at || parsed.data.end_at) && !(parsed.data.start_at && parsed.data.end_at)) {
      const effectiveStart = new Date(parsed.data.start_at || existing.startAt);
      const effectiveEnd = new Date(parsed.data.end_at || existing.endAt);
      if (effectiveEnd <= effectiveStart) {
        return errorJson(res, 400, 'VALIDATION_ERROR', 'end_at must be after start_at');
      }
    }

    const updated = await appointmentRepository.update(companyId, req.params.id, parsed.data);
    if (!updated) return errorJson(res, 404, 'NOT_FOUND', 'Appointment not found');

    const eventType = parsed.data.status === 'cancelled' ? 'appointment_cancelled' : 'appointment_updated';
    logLeadActivity({
      companyId, leadId: existing.leadId, eventType,
      actorType: req.user?.role === 'admin' ? 'admin' : 'user', actorUserId: req.user?.id,
      metadata: { appointmentId: updated.id, changes: Object.keys(parsed.data), message: `Appointment updated` },
    }).catch(() => {});

    if (parsed.data.status === 'cancelled' || parsed.data.start_at) {
      const notifTitle = parsed.data.status === 'cancelled' ? 'Appointment cancelled' : 'Appointment rescheduled';
      notificationRepository.create(companyId, {
        leadId: existing.leadId, type: 'appointment', title: notifTitle,
        body: `${updated.title} with ${updated.lead?.name || 'Lead'} – ${fmtTime(updated.startAt)}`,
        url: `/inbox/${existing.leadId}`,
      }).catch(() => {});
    }

    if (parsed.data.status === 'no_show') {
      const warmingService = require('../../services/warmingService');
      warmingService.enrollLead(existing.leadId, companyId, 'no_show_detected').catch((err) => logger.error('[appointments] warming no-show enroll error:', err.message));
    }

    const companyRow = (await pool.query(
      'SELECT id, google_calendar_connected, google_calendar_id, google_access_token, google_refresh_token, google_token_expiry FROM companies WHERE id = $1',
      [companyId]
    )).rows[0];
    if (companyRow?.google_calendar_connected && existing.google_event_id) {
      if (parsed.data.status === 'cancelled') {
        try {
          await googleCalendarService.deleteCalendarEvent(companyRow, existing.google_event_id);
          logger.info('[googleCalendar] Event deleted:', existing.google_event_id);
        } catch (err) {
          logger.error('[googleCalendar] Delete failed:', err.message);
        }
      } else if (parsed.data.start_at != null || parsed.data.end_at != null) {
        try {
          const lead = await leadRepository.findById(companyId, existing.leadId);
          await googleCalendarService.updateCalendarEvent(companyRow, { ...updated, google_event_id: existing.google_event_id }, lead);
          logger.info('[googleCalendar] Event updated:', existing.google_event_id);
        } catch (err) {
          logger.error('[googleCalendar] Update failed:', err.message);
        }
      }
    }

    res.json(updated);
  } catch (err) {
    logDbError('update', err, { id: req.params.id });
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to update appointment');
  }
});

router.post('/:id/reschedule', async (req, res) => {
  try {
    const parsed = rescheduleSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed, { route: 'POST /:id/reschedule' });

    const companyId = req.tenantId;
    const existing = await appointmentRepository.findById(companyId, req.params.id);
    if (!existing) return errorJson(res, 404, 'NOT_FOUND', 'Appointment not found');

    const patch = { start_at: parsed.data.start_at, end_at: parsed.data.end_at, status: 'scheduled' };
    if (parsed.data.timezone) patch.timezone = parsed.data.timezone;
    if (parsed.data.notes) {
      patch.notes = [existing.notes, `Rescheduled: ${parsed.data.notes}`].filter(Boolean).join('\n');
    }

    const updated = await appointmentRepository.update(companyId, req.params.id, patch);
    if (!updated) return errorJson(res, 404, 'NOT_FOUND', 'Appointment not found');

    if (existing.google_event_id) {
      const companyRow = (await pool.query(
        'SELECT id, google_calendar_connected, google_calendar_id, google_access_token, google_refresh_token, google_token_expiry FROM companies WHERE id = $1',
        [companyId]
      )).rows[0];
      if (companyRow?.google_calendar_connected) {
        try {
          const lead = await leadRepository.findById(companyId, existing.leadId);
          await googleCalendarService.updateCalendarEvent(companyRow, { ...updated, google_event_id: existing.google_event_id }, lead);
          logger.info('[googleCalendar] Event updated (reschedule):', existing.google_event_id);
        } catch (err) {
          logger.error('[googleCalendar] Update failed:', err.message);
        }
      }
    }

    logLeadActivity({
      companyId, leadId: existing.leadId, eventType: 'appointment_rescheduled',
      actorType: req.user?.role === 'admin' ? 'admin' : 'user', actorUserId: req.user?.id,
      metadata: { appointmentId: updated.id, message: `Appointment rescheduled to ${fmtTime(updated.startAt)}` },
    }).catch(() => {});

    notificationRepository.create(companyId, {
      leadId: existing.leadId, type: 'appointment', title: 'Appointment rescheduled',
      body: `${updated.title} with ${updated.lead?.name || 'Lead'} rescheduled to ${fmtTime(updated.startAt)}`,
      url: `/inbox/${existing.leadId}`,
    }).catch(() => {});

    res.json(updated);
  } catch (err) {
    logDbError('reschedule', err, { id: req.params.id });
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to reschedule appointment');
  }
});

router.post('/:id/status', async (req, res) => {
  try {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed, { route: 'POST /:id/status' });

    const companyId = req.tenantId;
    const existing = await appointmentRepository.findById(companyId, req.params.id);
    if (!existing) return errorJson(res, 404, 'NOT_FOUND', 'Appointment not found');

    const patch = { status: parsed.data.status };
    if (parsed.data.notes) {
      patch.notes = [existing.notes, `Status → ${parsed.data.status}: ${parsed.data.notes}`].filter(Boolean).join('\n');
    }

    const updated = await appointmentRepository.update(companyId, req.params.id, patch);
    if (!updated) return errorJson(res, 404, 'NOT_FOUND', 'Appointment not found');

    if (parsed.data.status === 'cancelled' && existing.google_event_id) {
      const companyRow = (await pool.query(
        'SELECT id, google_calendar_connected, google_calendar_id, google_access_token, google_refresh_token, google_token_expiry FROM companies WHERE id = $1',
        [companyId]
      )).rows[0];
      if (companyRow?.google_calendar_connected) {
        try {
          await googleCalendarService.deleteCalendarEvent(companyRow, existing.google_event_id);
          logger.info('[googleCalendar] Event deleted:', existing.google_event_id);
        } catch (err) {
          logger.error('[googleCalendar] Delete failed:', err.message);
        }
      }
    }

    const eventMap = { cancelled: 'appointment_cancelled', completed: 'appointment_completed', no_show: 'appointment_no_show', scheduled: 'appointment_rescheduled' };
    logLeadActivity({
      companyId, leadId: existing.leadId, eventType: eventMap[parsed.data.status] || 'appointment_updated',
      actorType: req.user?.role === 'admin' ? 'admin' : 'user', actorUserId: req.user?.id,
      metadata: { appointmentId: updated.id, status: parsed.data.status, message: `Appointment marked ${parsed.data.status}` },
    }).catch(() => {});

    if (parsed.data.status !== existing.status) {
      notificationRepository.create(companyId, {
        leadId: existing.leadId, type: 'appointment',
        title: `Appointment ${parsed.data.status}`,
        body: `${updated.title} with ${updated.lead?.name || 'Lead'} – ${parsed.data.status}`,
        url: `/inbox/${existing.leadId}`,
      }).catch(() => {});
    }

    res.json(updated);
  } catch (err) {
    logDbError('status', err, { id: req.params.id });
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to update appointment status');
  }
});

router.post('/:id/cancel', async (req, res) => {
  try {
    const parsed = cancelSchema.safeParse(req.body || {});
    if (!parsed.success) return validationError(res, parsed, { route: 'POST /:id/cancel' });

    const companyId = req.tenantId;
    const existing = await appointmentRepository.findById(companyId, req.params.id);
    if (!existing) return errorJson(res, 404, 'NOT_FOUND', 'Appointment not found');
    if (existing.status === 'cancelled') return errorJson(res, 409, 'CONFLICT', 'Appointment is already cancelled');

    const cancelled = await appointmentRepository.cancel(companyId, req.params.id, parsed.data.note);
    if (!cancelled) return errorJson(res, 404, 'NOT_FOUND', 'Appointment not found');

    if (existing.google_event_id) {
      const companyRow = (await pool.query(
        'SELECT id, google_calendar_connected, google_calendar_id, google_access_token, google_refresh_token, google_token_expiry FROM companies WHERE id = $1',
        [companyId]
      )).rows[0];
      if (companyRow?.google_calendar_connected) {
        try {
          await googleCalendarService.deleteCalendarEvent(companyRow, existing.google_event_id);
          logger.info('[googleCalendar] Event deleted:', existing.google_event_id);
        } catch (err) {
          logger.error('[googleCalendar] Delete failed:', err.message);
        }
      }
    }

    logLeadActivity({
      companyId, leadId: existing.leadId, eventType: 'appointment_cancelled',
      actorType: req.user?.role === 'admin' ? 'admin' : 'user', actorUserId: req.user?.id,
      metadata: { appointmentId: cancelled.id, note: parsed.data.note, message: `Appointment cancelled` },
    }).catch(() => {});

    notificationRepository.create(companyId, {
      leadId: existing.leadId, type: 'appointment', title: 'Appointment cancelled',
      body: `${cancelled.title} with ${cancelled.lead?.name || 'Lead'} – cancelled`,
      url: `/inbox/${existing.leadId}`,
    }).catch(() => {});

    res.json(cancelled);
  } catch (err) {
    logDbError('cancel', err, { id: req.params.id });
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to cancel appointment');
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const existing = await appointmentRepository.findById(companyId, req.params.id);
    if (!existing) return errorJson(res, 404, 'NOT_FOUND', 'Appointment not found');

    logLeadActivity({
      companyId, leadId: existing.leadId, eventType: 'appointment_deleted',
      actorType: req.user?.role === 'admin' ? 'admin' : 'user', actorUserId: req.user?.id,
      metadata: { appointmentId: existing.id, title: existing.title, message: `Appointment deleted: ${existing.title}` },
    }).catch(() => {});

    await appointmentRepository.hardDelete(companyId, req.params.id);
    res.json({ success: true, id: req.params.id });
  } catch (err) {
    logDbError('delete', err, { id: req.params.id });
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to delete appointment');
  }
});

module.exports = router;
module.exports.createAppointmentHandler = createAppointmentHandler;
