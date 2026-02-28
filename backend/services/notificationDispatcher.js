/**
 * Notification Dispatcher Service
 *
 * Dispatches notifications to configured channels:
 * - Slack (webhook)
 * - Telegram (bot API)
 * - In-app (existing poll-based system via notifications table)
 */

const logger = require('../src/lib/logger');
const { pool } = require('../db');

/**
 * Dispatch a notification to all enabled channels for a user.
 * Always creates the in-app notification, then fans out to Slack/Telegram if configured.
 */
async function dispatch(companyId, userId, { type, title, message, leadId = null, metadata = {} }) {
  // 1. Always create in-app notification
  try {
    await pool.query(
      `INSERT INTO notifications (company_id, type, title, message, lead_id, metadata, read, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, false, NOW())`,
      [companyId, type || 'info', title, message, leadId, JSON.stringify(metadata)]
    );
  } catch (err) {
    logger.warn({ err: err.message }, '[notificationDispatcher] Failed to create in-app notification');
  }

  // 2. Look up user's enabled channels
  let channels = [];
  try {
    const { rows } = await pool.query(
      `SELECT channel_type, channel_config, enabled
       FROM notification_channels
       WHERE user_id = $1 AND enabled = true`,
      [userId]
    );
    channels = rows;
  } catch (err) {
    logger.warn({ err: err.message }, '[notificationDispatcher] Failed to fetch channels');
    return;
  }

  // 3. Fan out to each enabled channel
  for (const ch of channels) {
    try {
      const config = typeof ch.channel_config === 'string'
        ? JSON.parse(ch.channel_config)
        : (ch.channel_config || {});

      if (ch.channel_type === 'slack') {
        await sendSlack(config, title, message);
      } else if (ch.channel_type === 'telegram') {
        await sendTelegram(config, title, message);
      }
      // 'browser' channel is handled client-side via polling
    } catch (err) {
      logger.warn({ err: err.message, channel: ch.channel_type }, '[notificationDispatcher] Channel dispatch failed');
    }
  }
}

/**
 * Dispatch a notification to ALL users in a company (e.g. system-wide alerts).
 */
async function dispatchToCompany(companyId, { type, title, message, leadId = null, metadata = {} }) {
  try {
    const { rows: users } = await pool.query(
      `SELECT id FROM users WHERE company_id = $1`,
      [companyId]
    );
    await Promise.allSettled(
      users.map(u => dispatch(companyId, u.id, { type, title, message, leadId, metadata }))
    );
  } catch (err) {
    logger.warn({ err: err.message }, '[notificationDispatcher] dispatchToCompany failed');
  }
}

/**
 * Dispatch to a specific role within a company (e.g. notify all admins).
 */
async function dispatchToRole(companyId, role, { type, title, message, leadId = null, metadata = {} }) {
  try {
    const { rows: users } = await pool.query(
      `SELECT id FROM users WHERE company_id = $1 AND role = $2`,
      [companyId, role]
    );
    await Promise.allSettled(
      users.map(u => dispatch(companyId, u.id, { type, title, message, leadId, metadata }))
    );
  } catch (err) {
    logger.warn({ err: err.message }, '[notificationDispatcher] dispatchToRole failed');
  }
}

// ---------------------------------------------------------------------------
// Channel implementations
// ---------------------------------------------------------------------------

async function sendSlack(config, title, message) {
  const webhookUrl = config.webhook_url;
  if (!webhookUrl) return;

  const payload = {
    text: `*${title}*\n${message}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${title}*\n${message}`,
        },
      },
    ],
  };

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Slack webhook returned ${res.status}`);
  }
}

async function sendTelegram(config, title, message) {
  const botToken = config.bot_token;
  const chatId = config.chat_id;
  if (!botToken || !chatId) return;

  const text = `<b>${escapeHtml(title)}</b>\n${escapeHtml(message)}`;

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Telegram API returned ${res.status}: ${body}`);
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = { dispatch, dispatchToCompany, dispatchToRole };
