/**
 * ManyChat webhook by company webhook_token: POST /api/webhook/manychat/:webhookToken
 * No global signature; the token in the URL identifies the company.
 */
const logger = require('../../lib/logger');
const express = require('express');
const { pool } = require('../../../db');
const { processManyChatPayload } = require('./manychat');
const { decrypt } = require('../../lib/encryption');

const router = express.Router();

router.post('/:webhookToken', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const webhookToken = req.params.webhookToken;
    if (!webhookToken) {
      return res.status(400).json({ error: 'webhook_token required' });
    }
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : typeof req.body === 'string'
        ? Buffer.from(req.body, 'utf8')
        : null;
    if (!rawBody || rawBody.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid body' });
    }
    let payload;
    try {
      payload = JSON.parse(rawBody.toString());
    } catch (e) {
      // Sanitize control characters (e.g. raw newlines in multi-line DMs) and retry
      try {
        const sanitized = rawBody.toString().replace(
          /"((?:[^"\\]|\\.)*)"/g,
          (match, contents) => {
            const fixed = contents.replace(/[\u0000-\u001F]/g, (c) => {
              const escapes = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };
              return escapes[c] || ('\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
            });
            return '"' + fixed + '"';
          }
        );
        payload = JSON.parse(sanitized);
      } catch (e2) {
        return res.status(400).json({ error: 'Invalid JSON body' });
      }
    }

    const companyResult = await pool.query(
      `SELECT id, manychat_api_key, operating_mode, bot_enabled,
              voice_enabled, voice_mode, voice_selected_id, voice_model,
              voice_stability, voice_similarity_boost, voice_style, voice_speaker_boost,
              meta_page_access_token, instagram_account_id
       FROM companies WHERE webhook_token = $1`,
      [webhookToken]
    );
    const companyRow = companyResult.rows[0];
    if (!companyRow) {
      return res.status(404).json({ error: 'Company not found for this webhook token' });
    }

    res.status(200).json({ received: true });

    // If message text was passed as a query param (to avoid ManyChat JSON template failures
    // on multi-line messages), inject it into the payload before processing.
    const queryMsg = req.query?.msg;
    if (queryMsg && typeof queryMsg === 'string' && queryMsg.trim().length > 0) {
      if (!payload.message) payload.message = {};
      if (!payload.message.text) payload.message.text = queryMsg.trim();
    }

    // Deduplicate: Redis-backed dedup shared with main webhook
    const messageId = payload.id ?? null;
    if (messageId) {
      const { isMessageProcessed } = require('../../lib/redis');
      const isDuplicate = await isMessageProcessed(messageId, 3600);
      if (isDuplicate) {
        logger.info({ messageId }, 'Duplicate messageId skipped (webhook-by-token)');
        return;
      }
    }

    processManyChatPayload(payload, companyRow).catch((err) => {
      logger.error('[manychat/webhook-by-token] Async processing error:', err);
    });
  } catch (err) {
    logger.error('[manychat/webhook-by-token] Error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal error' });
    }
  }
});

module.exports = router;
