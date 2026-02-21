/**
 * Email notification service with Resend provider.
 * Does not crash if env vars missing; logs warning and skips sending.
 */

let resendClient = null;

function initResend() {
  if (resendClient !== null) return resendClient;
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) {
    if (!process.env.EMAIL_PROVIDER) return null;
    console.warn('[emailService] RESEND_API_KEY or EMAIL_FROM not set; email notifications disabled');
    return null;
  }
  try {
    const { Resend } = require('resend');
    resendClient = new Resend(apiKey);
    return resendClient;
  } catch (err) {
    console.warn('[emailService] Resend init failed:', err.message);
    return null;
  }
}

function getFrom() {
  return process.env.EMAIL_FROM || 'notifications@example.com';
}

/**
 * Send new inquiry email. Does not throw; logs errors.
 * @param {string[]} to - recipient emails
 * @param {object} lead - { name, external_id, channel, source, status_name, created_at }
 * @param {string} [baseUrl] - optional frontend base URL for link
 */
async function sendNewLeadEmail(to, lead, baseUrl = null) {
  if (!to || to.length === 0) return;
  const client = initResend();
  if (!client) return;

  const source = lead.source ?? 'inbox';
  const subject = `New inquiry received (${source === 'inbox' ? 'Inbox' : 'Simulation'})`;
  const leadName = lead.name ?? lead.external_id ?? 'Unknown';
  const channel = lead.channel ?? '-';
  const status = lead.status_name ?? lead.status ?? '-';
  const createdAt = lead.created_at
    ? new Date(lead.created_at).toLocaleString()
    : new Date().toLocaleString();

  let body = `New inquiry received.\n\n`;
  body += `Lead: ${leadName}\n`;
  body += `Channel: ${channel}\n`;
  body += `Source: ${source}\n`;
  body += `Status: ${status}\n`;
  body += `Created: ${createdAt}\n`;
  if (baseUrl) {
    body += `\nView: ${baseUrl.replace(/\/+$/, '')}/inbox/${lead.id}\n`;
  }

  try {
    const { error } = await client.emails.send({
      from: getFrom(),
      to,
      subject,
      text: body,
    });
    if (error) {
      console.error('[emailService] Resend error:', error);
    }
  } catch (err) {
    console.error('[emailService] Send failed:', err.message);
  }
}

module.exports = {
  sendNewLeadEmail,
  initResend,
};
