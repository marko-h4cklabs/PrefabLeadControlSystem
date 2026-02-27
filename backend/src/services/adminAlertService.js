/**
 * Admin alert service. Sends system-level alerts via email (Resend) and Slack webhook.
 * Includes cooldown to prevent alert spam.
 */
const logger = require('../lib/logger');

const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between same alert
const alertTimestamps = new Map();

const ADMIN_EMAILS = (process.env.ADMIN_ALERT_EMAILS || '').split(',').filter(Boolean);
const SLACK_WEBHOOK = process.env.SLACK_ALERT_WEBHOOK || null;

/**
 * Send an admin alert. Deduplicates by alertKey within cooldown window.
 * @param {string} alertKey - Unique key for dedup (e.g. 'dlq:incoming:lead123')
 * @param {string} title - Alert title
 * @param {object} details - Alert details object
 */
async function sendAdminAlert(alertKey, title, details) {
  const lastSent = alertTimestamps.get(alertKey) || 0;
  if (Date.now() - lastSent < ALERT_COOLDOWN_MS) return;
  alertTimestamps.set(alertKey, Date.now());

  logger.error({ alertKey, title, details }, 'ADMIN ALERT');

  // Email alert via Resend
  if (ADMIN_EMAILS.length > 0 && process.env.RESEND_API_KEY) {
    try {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      const fromEmail = process.env.ALERT_FROM_EMAIL || process.env.RESEND_FROM_EMAIL || 'alerts@prefableadcontrol.com';
      await resend.emails.send({
        from: fromEmail,
        to: ADMIN_EMAILS,
        subject: `[PLCS ALERT] ${title}`,
        text: `Alert: ${title}\n\nDetails:\n${JSON.stringify(details, null, 2)}\n\nTime: ${new Date().toISOString()}`,
      });
    } catch (e) {
      logger.error({ err: e }, 'Failed to send admin alert email');
    }
  }

  // Slack webhook
  if (SLACK_WEBHOOK) {
    try {
      await fetch(SLACK_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `*[ALERT]* ${title}\n\`\`\`${JSON.stringify(details, null, 2)}\`\`\``,
        }),
      });
    } catch (e) {
      logger.error({ err: e }, 'Failed to send Slack alert');
    }
  }
}

// Cleanup old cooldown entries every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - ALERT_COOLDOWN_MS * 2;
  for (const [key, ts] of alertTimestamps) {
    if (ts < cutoff) alertTimestamps.delete(key);
  }
}, 10 * 60 * 1000);

module.exports = { sendAdminAlert };
