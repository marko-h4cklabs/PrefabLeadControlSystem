/**
 * ManyChat Webhook Receiver
 *
 * Receives incoming Instagram messages from ManyChat.
 * Verifies x-manychat-signature (plain string comparison).
 * Returns 200 immediately; processes AI reply asynchronously.
 */

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
const { analyzeInboundMessage } = require('../../../services/leadIntelligenceService');
const { sendInstagramMessage, sendManyChatImage } = require('../../services/manychatService');
const { createNotification } = require('../../services/notificationService');

const rawJsonParser = express.raw({ type: 'application/json' });

const MESSAGE_LIMITS = { trial: 100, pro: 2000, enterprise: 999999 };

/**
 * Extract message content and type from ManyChat webhook payload.
 * Handles text, audio/voice, image, and other types.
 */
function extractMessageContent(payload) {
  const message = payload.message ?? {};
  if (message.text) {
    return { type: 'text', content: message.text };
  }
  if (
    message.type === 'audio' ||
    message.type === 'voice' ||
    (Array.isArray(message.attachments) &&
      message.attachments.some((a) => a.type === 'audio' || a.type === 'voice')) ||
    message.audio ||
    payload.type === 'audio'
  ) {
    const audioUrl =
      message.audio?.url ||
      (Array.isArray(message.attachments)
        ? message.attachments.find((a) => a.type === 'audio' || a.type === 'voice')?.payload?.url
        : null) ||
      message.url ||
      null;
    return { type: 'audio', content: null, audioUrl };
  }
  if (
    message.type === 'image' ||
    (Array.isArray(message.attachments) && message.attachments.some((a) => a.type === 'image'))
  ) {
    return { type: 'image', content: null };
  }
  if (message.type && message.type !== 'text') {
    return { type: message.type, content: null };
  }
  return { type: 'unknown', content: null };
}

async function incrementMessageCountAndWarn(companyId) {
  const r = await pool.query(
    `UPDATE companies SET monthly_message_count = COALESCE(monthly_message_count, 0) + 1
     WHERE id = $1
     RETURNING monthly_message_count, subscription_plan`,
    [companyId]
  );
  const row = r.rows[0];
  if (!row) return;
  const limit = MESSAGE_LIMITS[row.subscription_plan] ?? 100;
  if (row.monthly_message_count > limit) {
    console.warn(
      `[billing] Company ${companyId} exceeded message limit: ${row.monthly_message_count} > ${limit}`
    );
  }
}

/**
 * POST /api/webhooks/manychat
 * Receives ManyChat incoming messages. Verifies x-manychat-signature.
 */
router.post('/', rawJsonParser, async (req, res) => {
  try {
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : typeof req.body === 'string'
        ? Buffer.from(req.body, 'utf8')
        : null;

    if (!rawBody || rawBody.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid body' });
    }

    const expectedSecret = process.env.MANYCHAT_WEBHOOK_SECRET;
    const signature = req.headers['x-manychat-signature'];
    if (!signature || signature !== expectedSecret) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString());
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    res.status(200).json({ received: true });

    processManyChatPayload(payload).catch((err) => {
      console.error('[manychat/webhook] Async processing error:', err);
    });
  } catch (err) {
    console.error('[manychat/webhook] Error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal error' });
    }
  }
});

/**
 * Process inbound ManyChat payload. When overrideCompany is provided, use it; otherwise resolve company by page_id.
 * @param {object} payload - ManyChat webhook payload
 * @param {object} [overrideCompany] - { id, manychat_api_key, operating_mode } to skip page_id lookup
 */
async function processManyChatPayload(payload, overrideCompany) {
  const startedAt = Date.now();
  let companyId = null;
  let success = false;
  const subscriber = payload.subscriber ?? {};
  const subscriberId = String(subscriber.id ?? '');
  const subscriberName = subscriber.name ?? null;
  const channel = (payload.channel ?? 'instagram').toLowerCase();
  const message = payload.message ?? {};
  const pageId = String(payload.page_id ?? '');
  const messageId = payload.id ?? null;
  const timestamp = payload.timestamp ?? null;
  const extracted = extractMessageContent(payload);
  let messagePreview = null;

  try {
  if (!subscriberId) {
    console.warn('[manychat/webhook] Missing subscriber.id');
    return;
  }

  let companyRow = overrideCompany;
  if (!companyRow) {
    if (!pageId) {
      console.warn('[manychat/webhook] Missing page_id and no override company');
      return;
    }
    const companyResult = await pool.query(
      'SELECT id, manychat_api_key, operating_mode FROM companies WHERE manychat_page_id = $1',
      [pageId]
    );
    companyRow = companyResult.rows[0];
    if (!companyRow) {
      console.warn('[manychat/webhook] Unregistered ManyChat page_id:', pageId);
      return;
    }
  }

  companyId = companyRow.id;
  const manychatApiKey = companyRow.manychat_api_key ?? null;
  const operating_mode = companyRow.operating_mode && ['autopilot', 'copilot'].includes(companyRow.operating_mode)
    ? companyRow.operating_mode
    : null;

  const blockedCheck = await pool.query(
    'SELECT 1 FROM blocked_users WHERE company_id = $1 AND external_id = $2 AND channel = $3 LIMIT 1',
    [companyId, subscriberId, 'instagram']
  );
  if (blockedCheck.rows && blockedCheck.rows.length > 0) {
    return;
  }

  let lead = await leadRepository.findByCompanyChannelExternalId(companyId, 'instagram', subscriberId, 'inbox');
  const isNewLead = !lead;

  if (!lead) {
    lead = await leadRepository.create(companyId, {
      channel: 'instagram',
      external_id: subscriberId,
      source: 'inbox',
      name: subscriberName || null,
    });
    createNotification(companyId, 'new_lead', 'New lead from Instagram', lead.name || 'New lead', lead.id).catch(() => {});
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
  } else if (subscriberName && (!lead.name || !lead.name.trim())) {
    await leadRepository.update(companyId, lead.id, { name: subscriberName }).catch(() => {});
  }

  let conversation = await conversationRepository.getByLeadId(lead.id);
  if (!conversation) {
    conversation = await conversationRepository.createIfNotExists(lead.id, companyId);
  }

  let content = '';
  if (extracted.type === 'audio' || extracted.type === 'voice') {
    let transcription = null;
    if (process.env.OPENAI_API_KEY && extracted.audioUrl) {
      try {
        const { transcribeAudioFromUrl } = require('../../../services/whisperService');
        transcription = await transcribeAudioFromUrl(extracted.audioUrl);
        if (transcription) transcription = String(transcription).trim();
      } catch (err) {
        console.warn('[manychat/webhook] Whisper transcription failed:', err.message);
      }
    }
    await conversationRepository.appendMessage(lead.id, 'user', transcription || '', {
      type: 'audio',
      is_voice: true,
      audio_url: extracted.audioUrl || null,
    });
    if (!transcription || !transcription.trim()) {
      const gracefulReply =
        "Hey! I got your voice message but I can't play audio right now. Could you type that out for me? 🙏";
      if (manychatApiKey) {
        await sendInstagramMessage(subscriberId, gracefulReply, manychatApiKey);
      }
      await conversationRepository.appendMessage(lead.id, 'assistant', gracefulReply);
      messagePreview = '[voice - no transcription]';
      success = true;
      return;
    }
    content = transcription;
    messagePreview = content.slice(0, 500);
  } else if (extracted.type === 'image') {
    const imageReply =
      'I can see you sent an image but I can only read text messages. What did you want to share?';
    if (manychatApiKey) {
      await sendInstagramMessage(subscriberId, imageReply, manychatApiKey);
    }
    await conversationRepository.appendMessage(lead.id, 'assistant', imageReply);
    messagePreview = '[image]';
    success = true;
    return;
  } else if (extracted.type === 'unknown' || extracted.content === null) {
    console.log('[manychat/webhook] Non-text message type ignored:', extracted.type);
    messagePreview = extracted.type ? `[${extracted.type}]` : null;
    success = true;
    return;
  } else {
    content = (extracted.content && String(extracted.content).trim()) || '';
    messagePreview = content ? content.slice(0, 500) : null;
  }

  if (extracted.type === 'text') {
    await conversationRepository.appendMessage(lead.id, 'user', content);
  }

  const conversationForCount = await conversationRepository.getByLeadId(lead.id);
  const userMessageCount = (conversationForCount?.messages || []).filter((m) => m.role === 'user').length;
  const { evaluateAutoresponderRules } = require('../../services/autoresponderService');
  await evaluateAutoresponderRules(lead, { text: content }, companyRow, manychatApiKey, { messageCount: userMessageCount }).catch((err) => {
    console.warn('[manychat] autoresponder:', err.message);
  });

  await pool.query('UPDATE leads SET last_engagement_at = NOW() WHERE id = $1', [lead.id]);
  const warmingService = require('../../services/warmingService');
  warmingService.cancelEnrollment(lead.id, 'no_show_detected').catch(() => {});
  warmingService.cancelEnrollment(lead.id, 'no_reply_72h').catch(() => {});

  logLeadActivity({
    companyId,
    leadId: lead.id,
    eventType: 'message_received',
    actorType: 'system',
    source: 'instagram',
    channel: 'instagram',
    metadata: { messageId, timestamp },
  }).catch(() => {});

  const conversationAfter = await conversationRepository.getByLeadId(lead.id);
  const messagesForIntelligence = conversationAfter?.messages ?? [];
  analyzeInboundMessage(lead.id, conversationAfter?.id, companyId, messagesForIntelligence).catch((err) => {
    console.error('[manychat/webhook] lead intelligence error:', err.message);
  });

  const quoteFields = await chatbotQuoteFieldsRepository.list(companyId);
  const hasChatbot = Array.isArray(quoteFields) && quoteFields.length > 0;

  if (hasChatbot) {
    const mode = operating_mode ?? 'autopilot';
    if (operating_mode === null) {
      console.warn('[manychat/webhook] operating_mode not set, defaulting to autopilot');
    }
    try {
      if (mode === 'copilot') {
        const replySuggestionsService = require('../../../services/replySuggestionsService');
        const behavior = (await require('../../../db/repositories').chatbotBehaviorRepository.get(companyId)) ?? {};
        await replySuggestionsService.generateSuggestions(lead.id, conversationAfter?.id, companyId, messagesForIntelligence, behavior);
      } else {
        const result = await aiReplyService.generateAiReply(companyId, lead.id);
        await conversationRepository.appendMessage(lead.id, 'assistant', result.assistant_message);

        const merged = result.parsed_fields ?? result.field_updates ?? {};
        const currentConv = await conversationRepository.getByLeadId(lead.id);
        const currentParsed = currentConv?.parsed_fields ?? {};
        if (JSON.stringify(merged) !== JSON.stringify(currentParsed) && Object.keys(merged).length > 0) {
          await conversationRepository.updateParsedFields(lead.id, merged);
        }

        if (manychatApiKey && result.assistant_message) {
          await sendInstagramMessage(subscriberId, result.assistant_message, manychatApiKey);
          incrementMessageCountAndWarn(companyId).catch((err) =>
            console.warn('[manychat/webhook] message count increment:', err.message)
          );

          const finalReply = (result.assistant_message || '').toLowerCase();
          const wantsToSendImages =
            finalReply.includes('send you some') ||
            finalReply.includes('show you') ||
            finalReply.includes('photos') ||
            finalReply.includes('examples');
          if (wantsToSendImages) {
            const behavior = (await require('../../../db/repositories').chatbotBehaviorRepository.get(companyId)) ?? {};
            if (behavior.social_proof_enabled) {
              const imagesResult = await pool.query(
                'SELECT url, caption FROM social_proof_images WHERE company_id = $1 AND send_when_asked = true LIMIT 3',
                [companyId]
              );
              const images = imagesResult.rows || [];
              for (const img of images) {
                await sendManyChatImage(lead, img.url, img.caption, companyRow);
              }
            }
          }
        } else if (!manychatApiKey) {
          console.warn('[manychat/webhook] manychat_api_key not set for company', companyId);
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
      }
    } catch (err) {
      console.error('[manychat/webhook] AI reply/suggestions failed:', err);
    }
  }
  success = true;
  } finally {
    const processingTimeMs = Date.now() - startedAt;
    pool.query(
      `INSERT INTO manychat_webhook_log (company_id, subscriber_id, message_preview, processing_time_ms, success)
       VALUES ($1, $2, $3, $4, $5)`,
      [companyId, subscriberId || null, messagePreview, processingTimeMs, success]
    ).catch((e) => console.warn('[manychat] webhook log insert failed:', e.message));
  }
}

module.exports = router;
module.exports.processManyChatPayload = processManyChatPayload;
