/**
 * Scaffold for appointment reminder emails.
 * Reuses existing email infra when available.
 */

const logger = require('../src/lib/logger');
let sendNewLeadEmail;
try {
  ({ sendNewLeadEmail } = require('./emailService'));
} catch {
  sendNewLeadEmail = null;
}

async function sendAppointmentReminderEmail({ to, leadName, appointmentTitle, appointmentType, startAt, timezone }) {
  const typeLabel = (appointmentType || 'call').replace(/_/g, ' ');
  const timeStr = startAt ? new Date(startAt).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }) : 'N/A';

  const subject = `Reminder: ${typeLabel} with ${leadName} at ${timeStr}`;
  const body = `You have an upcoming ${typeLabel} scheduled:\n\n` +
    `Lead: ${leadName}\n` +
    `Title: ${appointmentTitle}\n` +
    `Time: ${timeStr} (${timezone || 'Europe/Zagreb'})\n\n` +
    `Log in to view details.`;

  // TODO: Wire to actual email transport (sendgrid/ses/smtp) when ready
  logger.info('[appointmentEmail] reminder email scaffold:', { to, subject, bodyLength: body.length });
  return { sent: false, scaffold: true, subject };
}

async function sendAppointmentConfirmationEmail({ to, leadName, appointmentTitle, appointmentType, startAt, timezone }) {
  const typeLabel = (appointmentType || 'call').replace(/_/g, ' ');
  const timeStr = startAt ? new Date(startAt).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }) : 'N/A';

  const subject = `Appointment confirmed: ${typeLabel} with ${leadName}`;

  // TODO: Wire to actual email transport when ready
  logger.info('[appointmentEmail] confirmation email scaffold:', { to, subject });
  return { sent: false, scaffold: true, subject };
}

module.exports = { sendAppointmentReminderEmail, sendAppointmentConfirmationEmail };
