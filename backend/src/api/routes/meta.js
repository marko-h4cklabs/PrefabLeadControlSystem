/**
 * Meta/Instagram Webhook Handler
 *
 * Meta requires:
 * 1. GET endpoint - Webhook verification during setup (hub.mode, hub.verify_token, hub.challenge)
 * 2. POST endpoint - Receive events with HMAC-SHA256 signature verification
 *
 * Receives Instagram DMs sent to connected Instagram Business accounts.
 */

const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const { pool } = require('../../../db');
const {
  leadRepository,
  conversationRepository,
  chatbotQuoteFieldsRepository,
} = require('../../../db/repositories');
const { notifyNewLeadCreated } = require('../../../services/newLeadNotifier');
const { logLeadActivity } = require('../../../services/activityLogger');
const aiReplyService = require('../../../services/aiReplyService');

// POST /webhook needs raw body for signature verification - use express.raw() for this route only
const rawJsonParser = express.raw({ type: 'application/json' });

/**
 * GET /api/meta/webhook
 * Meta calls this during webhook setup to verify ownership.
 * Must return hub.challenge as plain text when verify_token matches.
 */
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN && challenge) {
    res.status(200).type('text/plain').send(challenge);
  } else {
    res.status(403).end();
  }
});

/**
 * POST /api/meta/webhook
 * Receives Instagram messaging events. Must verify x-hub-signature-256 HMAC before processing.
 * Respond 200 immediately; process events asynchronously.
 */
router.post('/webhook', rawJsonParser, (req, res) => {
  try {
    // Require raw body - if already parsed by express.json, req.body might be an object
    const rawBody = Buffer.isBuffer(req.body) ? req.body : (typeof req.body === 'string' ? Buffer.from(req.body, 'utf8') : null);
    if (!rawBody || rawBody.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid body' });
    }

    const sig = req.headers['x-hub-signature-256'];
    const secret = process.env.META_APP_SECRET;
    if (!secret) {
      console.error('[meta/webhook] META_APP_SECRET not configured');
      return res.status(500).json({ error: 'Server misconfiguration' });
    }

    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    if (!sig || sig !== expected) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString());
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    // Respond immediately - Meta requires fast response
    res.status(200).json({ received: true });

    // Process asynchronously (fire-and-forget)
    processMetaPayload(payload).catch((err) => {
      console.error('[meta/webhook] Async processing error:', err);
    });
  } catch (err) {
    console.error('[meta/webhook] Error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal error' });
    }
  }
});

/**
 * Process Meta webhook payload: entries -> messaging events.
 */
async function processMetaPayload(payload) {
  const entries = payload.entry ?? [];
  for (const entry of entries) {
    const messaging = entry.messaging ?? [];
    for (const ev of messaging) {
      await processMessagingEvent(ev).catch((err) => {
        console.error('[meta/webhook] Event processing error:', err);
      });
    }
  }
}

/**
 * Process a single messaging event (Instagram DM).
 */
async function processMessagingEvent(messaging) {
  const senderId = String(messaging.sender?.id ?? '');
  const recipientId = String(messaging.recipient?.id ?? '');
  const message = messaging.message ?? {};
  const messageText = message.text ?? null;
  const messageId = message.mid ?? null;
  const timestamp = messaging.timestamp ?? null;
  const attachments = message.attachments ?? [];
  const isEcho = message.is_echo === true;

  if (isEcho) return; // Skip messages sent by our page
  if (!messageText && attachments.length === 0) return; // Skip empty

  // Find company by Instagram account ID (recipient = our connected account)
  const companyResult = await pool.query(
    'SELECT id FROM companies WHERE instagram_account_id = $1',
    [recipientId]
  );
  const companyRow = companyResult.rows[0];
  if (!companyRow) {
    console.warn('[meta/webhook] Unregistered Instagram account:', recipientId);
    return;
  }

  const companyId = companyRow.id;

  // Find or create lead
  let lead = await leadRepository.findByCompanyChannelExternalId(companyId, 'instagram', senderId, 'inbox');
  const isNewLead = !lead;

  if (!lead) {
    lead = await leadRepository.create(companyId, {
      channel: 'instagram',
      external_id: senderId,
      source: 'inbox',
    });
    notifyNewLeadCreated(companyId, lead).catch(() => {});
    logLeadActivity({
      companyId,
      leadId: lead.id,
      eventType: 'lead_created',
      actorType: 'system',
      source: 'instagram',
      channel: 'instagram',
      metadata: {},
    }).catch(() => {});
  }

  // Find or create conversation (lead-scoped)
  let conversation = await conversationRepository.getByLeadId(lead.id);
  if (!conversation) {
    conversation = await conversationRepository.createIfNotExists(lead.id, companyId);
  }

  // Store inbound message in conversations (JSONB messages array)
  const content = messageText || (attachments.length > 0 ? '[Attachment]' : '');
  await conversationRepository.appendMessage(lead.id, 'user', content);

  logLeadActivity({
    companyId,
    leadId: lead.id,
    eventType: 'message_received',
    actorType: 'system',
    source: 'instagram',
    channel: 'instagram',
    metadata: { messageId, timestamp },
  }).catch(() => {});

  // If company has chatbot configured, generate and send AI reply
  const quoteFields = await chatbotQuoteFieldsRepository.list(companyId);
  const hasChatbot = Array.isArray(quoteFields) && quoteFields.length > 0;

  if (hasChatbot) {
    try {
      const result = await aiReplyService.generateAiReply(companyId, lead.id);
      await conversationRepository.appendMessage(lead.id, 'assistant', result.assistant_message);

      const merged = result.parsed_fields ?? result.field_updates ?? {};
      const currentConv = await conversationRepository.getByLeadId(lead.id);
      const currentParsed = currentConv?.parsed_fields ?? {};
      if (JSON.stringify(merged) !== JSON.stringify(currentParsed) && Object.keys(merged).length > 0) {
        await conversationRepository.updateParsedFields(lead.id, merged);
      }

      // Send reply back to Instagram via Meta Graph API
      const tokenResult = await pool.query(
        'SELECT meta_page_access_token FROM companies WHERE id = $1',
        [companyId]
      );
      const pageToken = tokenResult.rows[0]?.meta_page_access_token || process.env.META_PAGE_ACCESS_TOKEN;
      if (pageToken && result.assistant_message) {
        await sendInstagramMessage(pageToken, senderId, result.assistant_message);
      }

      logLeadActivity({
        companyId,
        leadId: lead.id,
        eventType: 'ai_reply_sent',
        actorType: 'ai',
        source: 'instagram',
        channel: 'instagram',
        metadata: {},
      }).catch(() => {});
    } catch (err) {
      console.error('[meta/webhook] AI reply failed:', err);
    }
  }
}

/**
 * Send a text message to an Instagram user via Meta Graph API.
 */
async function sendInstagramMessage(pageAccessToken, recipientId, text) {
  const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(pageAccessToken)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Meta Send API failed: ${res.status} ${errBody}`);
  }
}

module.exports = router;
