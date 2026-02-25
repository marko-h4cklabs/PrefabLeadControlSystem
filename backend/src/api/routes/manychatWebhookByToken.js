/**
 * ManyChat webhook by company webhook_token: POST /api/webhook/manychat/:webhookToken
 * No global signature; the token in the URL identifies the company.
 */
const express = require('express');
const { pool } = require('../../../db');
const { processManyChatPayload } = require('./manychat');

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
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    const companyResult = await pool.query(
      `SELECT id, manychat_api_key, operating_mode,
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
    processManyChatPayload(payload, companyRow).catch((err) => {
      console.error('[manychat/webhook-by-token] Async processing error:', err);
    });
  } catch (err) {
    console.error('[manychat/webhook-by-token] Error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal error' });
    }
  }
});

module.exports = router;
