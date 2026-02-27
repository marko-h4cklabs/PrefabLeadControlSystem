const logger = require('../src/lib/logger');
const { appointmentRepository, notificationRepository } = require('../db/repositories');

const POLL_INTERVAL_MS = 60_000;
let running = false;
let timer = null;

function fmtMinutes(mins) {
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h}h ${m}min` : `${h}h`;
  }
  return `${mins} min`;
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const due = await appointmentRepository.findDueReminders();
    for (const row of due) {
      try {
        const leadName = row.lead_name || row.lead_channel || 'Lead';
        const channel = row.lead_channel ? ` (${row.lead_channel})` : '';
        const typeLabel = (row.appointment_type || 'call').replace(/_/g, ' ');
        const body = `Upcoming ${typeLabel} in ${fmtMinutes(row.reminder_minutes_before)} — ${leadName}${channel}`;

        await notificationRepository.create(row.company_id, {
          leadId: row.lead_id,
          type: 'appointment_reminder',
          title: 'Appointment reminder',
          body,
          url: `/inbox/${row.lead_id}`,
        });

        await appointmentRepository.markReminderSent(row.appointment_id, row.reminder_minutes_before);
      } catch (err) {
        logger.error('[reminderWorker] failed to send reminder:', { appointmentId: row.appointment_id, error: err.message });
      }
    }
    if (due.length > 0) {
      logger.info(`[reminderWorker] sent ${due.length} reminder(s)`);
    }
  } catch (err) {
    logger.error('[reminderWorker] tick error:', err.message);
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  logger.info('[reminderWorker] started, polling every', POLL_INTERVAL_MS / 1000, 's');
  tick();
  timer = setInterval(tick, POLL_INTERVAL_MS);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('[reminderWorker] stopped');
  }
}

async function runOnce() {
  if (running) return 0;
  running = true;
  let count = 0;
  try {
    const due = await appointmentRepository.findDueReminders();
    for (const row of due) {
      try {
        const leadName = row.lead_name || row.lead_channel || 'Lead';
        const channel = row.lead_channel ? ` (${row.lead_channel})` : '';
        const typeLabel = (row.appointment_type || 'call').replace(/_/g, ' ');
        const body = `Upcoming ${typeLabel} in ${fmtMinutes(row.reminder_minutes_before)} — ${leadName}${channel}`;

        await notificationRepository.create(row.company_id, {
          leadId: row.lead_id,
          type: 'appointment_reminder',
          title: 'Appointment reminder',
          body,
          url: `/inbox/${row.lead_id}`,
        });

        await appointmentRepository.markReminderSent(row.appointment_id, row.reminder_minutes_before);
        count++;
      } catch (err) {
        logger.error('[reminderWorker] runOnce single:', { appointmentId: row.appointment_id, error: err.message });
      }
    }
  } catch (err) {
    logger.error('[reminderWorker] runOnce error:', err.message);
  } finally {
    running = false;
  }
  return count;
}

module.exports = { start, stop, runOnce };
