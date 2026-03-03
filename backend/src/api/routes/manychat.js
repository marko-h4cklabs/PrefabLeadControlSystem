/**
 * ManyChat Webhook Receiver
 *
 * Receives incoming Instagram messages from ManyChat.
 * Verifies x-manychat-signature (plain string comparison).
 * Returns 200 immediately; processes AI reply asynchronously.
 */

const express = require('express');
const router = express.Router();
const logger = require('../../lib/logger');
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
const { sendInstagramMessage, sendManyChatImage, sendManyChatFile } = require('../../services/manychatService');
const { createNotification } = require('../../services/notificationService');
const handoffService = require('../../services/handoffService');
const incomingMessageQueue = require('../../../services/incomingMessageQueue');
const { checkMessageLimit } = require('../../middleware/checkSubscription');
const { isMessageProcessed, acquireDistributedLock, releaseDistributedLock } = require('../../lib/redis');
const { decrypt } = require('../../lib/encryption');
const { publish: publishEvent } = require('../../lib/eventBus');

const rawJsonParser = express.raw({ type: 'application/json' });

const MESSAGE_LIMITS = { trial: 100, pro: 2000, enterprise: 999999 };

/**
 * Extract message content and type from ManyChat webhook payload.
 * Handles text, audio/voice, image, and other types.
 *
 * IMPORTANT:
 * - Audio/voice messages are detected from structured payload fields (type, attachments, audio_url).
 * - We prefer real audio payloads over plain text like "sent a voice message".
 */
function extractMessageContent(payload) {
  const msg = payload.message || payload || {};

  // First, detect real audio/voice based on structured fields (type, audio_url, attachments).
  const attachmentAudio = Array.isArray(msg.attachments)
    ? msg.attachments.find((a) => a && (a.type === 'audio' || a.type === 'voice'))
    : null;

  const audioUrl =
    msg.audio_url ||
    (msg.audio && msg.audio.url) ||
    (attachmentAudio && attachmentAudio.payload && attachmentAudio.payload.url) ||
    null;

  const isAudio =
    msg.type === 'audio' ||
    msg.type === 'voice' ||
    !!audioUrl;

  if (isAudio) {
    return { type: 'audio', content: null, audioUrl };
  }

  // Detect Instagram voice messages sent by ManyChat as a plain text CDN URL
  if (msg.text && typeof msg.text === 'string') {
    const trimmed = msg.text.trim();
    if (trimmed.includes('lookaside.fbsbx.com/ig_messaging_cdn')) {
      return { type: 'audio', content: null, audioUrl: trimmed };
    }
  }

  // TEXT message — if there is a text field with actual text content and no audio payload.
  if (msg.text && typeof msg.text === 'string' && msg.text.trim().length > 0) {
    return { type: 'text', content: msg.text.trim() };
  }

  // Image
  if (
    msg.type === 'image' ||
    (Array.isArray(msg.attachments) && msg.attachments.some((a) => a.type === 'image'))
  ) {
    return { type: 'image', content: null };
  }

  // Sticker, reaction, like, thumbs up — pass through type
  if (msg.type && msg.type !== 'text') {
    return { type: msg.type, content: null };
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
    logger.warn({ companyId, used: row.monthly_message_count, limit }, 'Company exceeded message limit');
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

    if (rawBody) {
      try {
        logger.info({ rawBody: rawBody.toString('utf8') }, '[manychat/webhook] Raw body');
      } catch (e) {
        logger.warn({ err: e.message }, '[manychat/webhook] Failed to log raw body');
      }
    }

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
      // ManyChat inserts message text raw without escaping control characters
      // (e.g. literal newlines in multi-line DMs). Sanitize string values and retry.
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

    res.status(200).json({ received: true });

    // If message text was passed as a query param (to avoid ManyChat JSON template failures
    // on multi-line messages), inject it into the payload before processing.
    const queryMsg = req.query?.msg;
    if (queryMsg && typeof queryMsg === 'string' && queryMsg.trim().length > 0) {
      if (!payload.message) payload.message = {};
      if (!payload.message.text) payload.message.text = queryMsg.trim();
    }

    // Enqueue for async processing via BullMQ (persistent, retryable, concurrency-limited).
    // Falls back to fire-and-forget if Redis is unavailable.
    const messageId = payload.id ?? null;
    if (process.env.REDIS_URL) {
      incomingMessageQueue.enqueueMessage(payload, messageId).catch((err) => {
        logger.error({ err: err.message }, '[manychat/webhook] Queue enqueue failed, falling back to direct processing');
        processManyChatPayload(payload).catch((e) => {
          logger.error({ err: e }, '[manychat/webhook] Fallback processing error');
        });
      });
    } else {
      processManyChatPayload(payload).catch((err) => {
        logger.error({ err }, '[manychat/webhook] Async processing error');
      });
    }
  } catch (err) {
    logger.error({ err }, '[manychat/webhook] Error');
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
  // --- Duplicate webhook protection: Redis-backed dedup (survives redeploy) ---
  if (messageId) {
    const isDuplicate = await isMessageProcessed(messageId, 3600);
    if (isDuplicate) {
      logger.info({ messageId }, 'Duplicate messageId skipped');
      return;
    }
  }

  // IGSID discovery: log all subscriber fields and payload keys to find the Instagram-scoped user ID
  logger.info({ payloadKeys: Object.keys(payload) }, '[manychat/igsid-discovery] payload keys');
  logger.info({ subscriber }, '[manychat/igsid-discovery] subscriber fields');
  logger.info({ pageId, channel }, '[manychat/igsid-discovery] page_id and channel');

  logger.info({
    type: extracted?.type,
    hasContent: !!extracted?.content,
    audioUrl: extracted?.audioUrl || null,
  }, '[manychat/webhook] Extracted message');
  if (!subscriberId) {
    logger.warn('[manychat/webhook] Missing subscriber.id');
    return;
  }

  let companyRow = overrideCompany;
  if (!companyRow) {
    if (!pageId) {
      logger.warn('[manychat/webhook] Missing page_id and no override company');
      return;
    }
    const companyResult = await pool.query(
      `SELECT id, manychat_api_key, operating_mode, bot_enabled,
              voice_enabled, voice_mode, voice_selected_id, voice_model,
              voice_stability, voice_similarity_boost, voice_style, voice_speaker_boost,
              meta_page_access_token, instagram_account_id
       FROM companies WHERE manychat_page_id = $1`,
      [pageId]
    );
    companyRow = companyResult.rows[0];
    if (!companyRow) {
      logger.warn({ pageId }, '[manychat/webhook] Unregistered ManyChat page_id');
      return;
    }
  }

  companyId = companyRow.id;
  const manychatApiKey = decrypt(companyRow.manychat_api_key) ?? null;
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
    // Emit SSE event so DM list refreshes instantly for new leads
    publishEvent(companyId, {
      type: 'new_lead',
      leadId: lead.id,
      leadName: lead.name || subscriberName || null,
    }).catch(() => {});
  } else if (subscriberName && (!lead.name || !lead.name.trim())) {
    await leadRepository.update(companyId, lead.id, { name: subscriberName }).catch(() => {});
  }

  let conversation = await conversationRepository.getByLeadId(lead.id);
  if (!conversation) {
    conversation = await conversationRepository.createIfNotExists(lead.id, companyId);
  }

  let content = '';
  const isAudioMessage = extracted.type === 'audio' || extracted.type === 'voice';
  if (isAudioMessage) {
    let transcription = null;
    if (process.env.OPENAI_API_KEY && extracted.audioUrl) {
      try {
        const { transcribeAudioFromUrl } = require('../../../services/whisperService');
        logger.info({ audioUrl: extracted.audioUrl }, '[manychat/webhook] Detected audio/voice message');
        transcription = await transcribeAudioFromUrl(extracted.audioUrl);
        if (transcription) transcription = String(transcription).trim();
        logger.info({ transcription: transcription ? transcription.slice(0, 500) : null }, '[manychat/webhook] Whisper transcription result');
      } catch (err) {
        logger.warn({ err: err.message }, '[manychat/webhook] Whisper transcription failed');
      }
    }
    await conversationRepository.appendMessage(lead.id, 'user', transcription || '', {
      type: 'audio',
      is_voice: true,
      audio_url: extracted.audioUrl || null,
    });
    if (!transcription || !transcription.trim()) {
      const gracefulReply =
        "Hey, I can't play audio messages on my end — can you type that out for me?";
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
    logger.info({ type: extracted.type }, '[manychat/webhook] Non-text message type ignored');
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
    logger.warn({ err: err.message }, '[manychat] autoresponder error');
  });

  await pool.query('UPDATE leads SET last_engagement_at = NOW() WHERE id = $1', [lead.id]);
  const warmingService = require('../../services/warmingService');
  warmingService.cancelEnrollment(lead.id, 'no_show_detected').catch(() => {});
  warmingService.cancelEnrollment(lead.id, 'no_reply_72h').catch(() => {});
  // Record reply for warming follow-up tracking (sentiment + reply status)
  warmingService.recordLeadReply(lead.id, content).catch(() => {});

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
    logger.error({ err: err.message }, '[manychat/webhook] lead intelligence error');
  });

  // Emit SSE event with full message data so frontend can display instantly
  publishEvent(companyId, {
    type: 'new_message',
    leadId: lead.id,
    conversationId: conversation?.id,
    preview: messagePreview || content?.slice(0, 100) || '',
    role: 'user',
    content: content || '',
    messageTimestamp: new Date().toISOString(),
    leadName: lead.name || subscriberName || null,
    assignedTo: lead.assigned_to || null,
    isNewLead,
  }).catch(() => {});

  const quoteFields = await chatbotQuoteFieldsRepository.list(companyId);
  const hasChatbot = Array.isArray(quoteFields) && quoteFields.length > 0;

  // --- MESSAGE LIMIT: block AI replies when limit is exceeded ---
  const limitCheck = await checkMessageLimit(companyId);
  if (!limitCheck.allowed) {
    logger.warn({ companyId, used: limitCheck.used, limit: limitCheck.limit }, 'AI reply blocked - message limit exceeded');
    createNotification(companyId, 'message_limit_warning', 'Message limit reached', `You have used ${limitCheck.used}/${limitCheck.limit} messages this month. Upgrade your plan to continue AI replies.`, lead.id).catch(() => {});
    success = true;
    return;
  }

  if (hasChatbot) {
    // --- HANDOFF: check if bot is paused for this conversation ---
    const isBotPaused = await conversationRepository.isPaused(lead.id);
    if (isBotPaused) {
      logger.info({ leadId: lead.id }, '[manychat/handoff] Bot paused for lead — skipping AI reply, message already logged');
      // Still create notification so owner knows lead sent another message
      createNotification(companyId, 'new_message', 'New message (bot paused)', `${lead.name || 'Lead'} sent a message while bot is paused`, lead.id).catch(() => {});
      success = true;
      return;
    }

    // --- HANDOFF: evaluate rules before generating AI reply ---
    try {
      const userMsgCount = (conversationAfter?.messages || []).filter(m => m.role === 'user').length;
      const matchedRule = await handoffService.evaluateWithContext(companyId, lead.id, content, {
        messageCount: userMsgCount,
      });
      if (matchedRule) {
        logger.info({ ruleType: matchedRule.rule_type, triggerValue: matchedRule.trigger_value, leadId: lead.id }, '[manychat/handoff] Rule triggered');
        const handoffResult = await handoffService.executeHandoff(companyId, lead.id, conversationAfter?.id, matchedRule, lead.name);
        if (handoffResult.paused && handoffResult.bridgingMessage && manychatApiKey) {
          await sendInstagramMessage(subscriberId, handoffResult.bridgingMessage, manychatApiKey);
          await conversationRepository.appendMessage(lead.id, 'assistant', handoffResult.bridgingMessage, { handoff: true });
        }
        success = true;
        return;
      }
    } catch (handoffErr) {
      logger.warn({ err: handoffErr.message }, '[manychat/handoff] Rule evaluation error');
    }

    // Kill switch: if bot is disabled, store message but skip AI processing
    if (companyRow.bot_enabled === false) {
      logger.info({ companyId }, '[manychat/webhook] Bot disabled (kill switch), message stored only');
      success = true;
      return;
    }

    const mode = operating_mode ?? 'autopilot';
    if (operating_mode === null) {
      logger.warn('[manychat/webhook] operating_mode not set, defaulting to autopilot');
    }
    // Acquire per-lead lock (Redis-backed distributed lock, survives redeploy)
    const lockAcquired = await acquireDistributedLock(`lead:${lead.id}`, 90);
    if (!lockAcquired) {
      logger.warn({ leadId: lead.id }, 'Lead already being processed, skipping');
      success = true;
      return;
    }
    try {
      if (mode === 'copilot') {
        // NOTE: Suggestions are NOT generated here. The frontend generates them
        // when it receives the SSE "user" message event (POST /suggestions).
        // Generating here would race with the frontend: this Claude API call takes
        // 3-5s, and if the user sends another message in that window, the stale
        // suggestions from THIS call overwrite the frontend's correct ones.

        // Extract field values from user message (copilot mode needs this for Collected Fields)
        try {
          const copilotFields = await chatbotQuoteFieldsRepository.list(companyId, 'copilot');
          if (Array.isArray(copilotFields) && copilotFields.length > 0) {
            const { extractFieldsWithClaude, getAllowedFieldNames } = require('../../../src/chat/extractService');
            const { extracted } = await extractFieldsWithClaude(content, copilotFields);
            if (extracted && extracted.length > 0) {
              const currentConv = await conversationRepository.getByLeadId(lead.id);
              const currentParsed = currentConv?.parsed_fields ?? {};
              const allowed = getAllowedFieldNames(copilotFields);
              const updates = {};
              for (const e of extracted) {
                if (e?.name && e?.value != null && String(e.value).trim() !== '') {
                  const key = String(e.name).toLowerCase().trim();
                  if (allowed.has(key)) {
                    updates[e.name] = e.type === 'number' ? Number(e.value) : String(e.value).trim();
                  }
                }
              }
              if (Object.keys(updates).length > 0) {
                const merged = { ...currentParsed, ...updates };
                await conversationRepository.updateParsedFields(lead.id, merged);
                logger.info({ leadId: lead.id, fields: Object.keys(updates) }, '[manychat/copilot] Extracted fields from user message');
              }
            }
          }
        } catch (extractErr) {
          logger.warn({ err: extractErr.message }, '[manychat/copilot] Field extraction error');
        }

        // Auto-assign to setter if not already assigned
        try {
          const { autoAssign } = require('../../../services/assignmentService');
          await autoAssign(companyId, lead.id);
        } catch (assignErr) {
          logger.warn({ err: assignErr.message }, '[manychat/webhook] Auto-assign failed');
        }

        // Pre-generate suggestions in the background so they're ready when setter opens the chat.
        // Fire-and-forget: generateSuggestions handles Claude call + reply_suggestions insert +
        // publishing 'suggestion_ready' SSE event. The setter sees suggestions immediately on open.
        conversationRepository.getByLeadId(lead.id).then((convForSug) => {
          if (!convForSug?.id) return;
          const { generateSuggestions } = require('../../../services/replySuggestionsService');
          return generateSuggestions(lead.id, convForSug.id, companyId, convForSug.messages, null);
        }).catch((err) => {
          logger.warn({ err: err.message }, '[manychat/copilot] Suggestion pre-generation failed');
        });
      } else {
        const behavior = (await require('../../../db/repositories').chatbotBehaviorRepository.get(companyId)) ?? {};

        // --- BOOKING: check if user is in an active booking flow ---
        const { handleActiveBookingPhase, evaluatePostReplyBooking } = require('../../../services/manychatBookingHandler');
        const { isActiveBookingPhase } = require('../../../services/bookingTriggerService');
        const convForBooking = await conversationRepository.getByLeadId(lead.id);
        const parsedFields = convForBooking?.parsed_fields ?? {};
        const bookingPhase = parsedFields.__booking_phase || null;
        const bookingData = parsedFields.__booking || null;

        if (isActiveBookingPhase(bookingPhase)) {
          logger.info({ bookingPhase, leadId: lead.id }, '[booking] Active phase');
          const bookingResult = await handleActiveBookingPhase({
            leadId: lead.id,
            companyId,
            userMessage: content,
            bookingPhase,
            bookingData,
            lead,
          });
          if (bookingResult?.handled && bookingResult.replyMessage) {
            await conversationRepository.appendMessage(lead.id, 'assistant', bookingResult.replyMessage);
            if (manychatApiKey) {
              await sendInstagramMessage(subscriberId, bookingResult.replyMessage, manychatApiKey);
              incrementMessageCountAndWarn(companyId).catch(() => {});
            }
            logLeadActivity({ companyId, leadId: lead.id, eventType: 'ai_reply_sent', actorType: 'ai', source: 'instagram', channel: 'instagram', metadata: { bookingPhase } }).catch(() => {});
            success = true;
            return;
          }
          // Not handled — fall through to normal AI reply
        }

        // Smart delay: wait before replying, reset if user sends another message
        const delaySeconds = Number(behavior.response_delay_seconds) || 0;
        const delayRandomEnabled = !!behavior.delay_random_enabled;
        const delayMin = Number(behavior.delay_min_seconds) || 0;
        const delayMax = Number(behavior.delay_max_seconds) || 0;
        const hasDelay = delayRandomEnabled ? (delayMax > 0) : (delaySeconds > 0);
        if (hasDelay) {
          const messageDelayService = require('../../services/messageDelayService');
          logger.info({ delay: delayRandomEnabled ? `random ${delayMin}-${delayMax}s` : `${delaySeconds}s`, leadId: lead.id }, '[manychat/webhook] Smart delay');
          const shouldProceed = await messageDelayService.waitOrReset(lead.id, delaySeconds, {
            minSeconds: delayMin,
            maxSeconds: delayMax,
            randomEnabled: delayRandomEnabled,
          });
          if (!shouldProceed) {
            logger.info({ leadId: lead.id }, '[manychat/webhook] Smart delay: superseded by newer message, skipping reply');
            return;
          }
          logger.info({ leadId: lead.id }, '[manychat/webhook] Smart delay: timer expired, proceeding with reply');
        }

        const result = await aiReplyService.generateAiReply(companyId, lead.id);

        // --- BOOKING: evaluate if we should offer booking after AI reply ---
        const quoteComplete = Array.isArray(result.missing_required_infos) && result.missing_required_infos.length === 0;
        const refreshedConv = await conversationRepository.getByLeadId(lead.id);
        const refreshedParsed = refreshedConv?.parsed_fields ?? {};
        const currentBookingPhase = refreshedParsed.__booking_phase || null;
        const currentBookingData = refreshedParsed.__booking || null;
        let bookingOfferAppended = false;

        const bookingOffer = await evaluatePostReplyBooking({
          leadId: lead.id,
          companyId,
          userMessage: content,
          quoteComplete,
          bookingPhase: currentBookingPhase,
          bookingData: currentBookingData,
        });
        if (bookingOffer?.offerMessage) {
          result.assistant_message += bookingOffer.offerMessage;
          bookingOfferAppended = true;
          logger.info({ bookingPhase: bookingOffer.bookingPhase }, '[booking] Offer appended');
        }

        await conversationRepository.appendMessage(lead.id, 'assistant', result.assistant_message);

        const merged = result.parsed_fields ?? result.field_updates ?? {};
        if (Object.keys(merged).length > 0) {
          // Preserve booking state keys when updating parsed fields from AI extraction
          const latestConv = await conversationRepository.getByLeadId(lead.id);
          const latestParsed = latestConv?.parsed_fields ?? {};
          const withBooking = { ...merged };
          if (latestParsed.__booking_phase !== undefined) withBooking.__booking_phase = latestParsed.__booking_phase;
          if (latestParsed.__booking !== undefined) withBooking.__booking = latestParsed.__booking;
          await conversationRepository.updateParsedFields(lead.id, withBooking);
        }

        if (manychatApiKey && result.assistant_message) {
          // Determine if voice reply should be sent instead of text
          // Don't use voice if booking offer was appended (slot lists need to be readable)
          const shouldSendVoice =
            !bookingOfferAppended &&
            companyRow.voice_enabled &&
            companyRow.voice_selected_id &&
            (companyRow.voice_mode === 'always' || (companyRow.voice_mode === 'match' && isAudioMessage));

          let voiceSent = false;

          // If voice reply is needed, try voice FIRST (don't send text yet)
          if (shouldSendVoice) {
            try {
              const { textToSpeechWav } = require('../../utils/elevenLabsClient');
              const chatAttachmentRepository = require('../../../db/repositories/chatAttachmentRepository');

              // Step 1: Generate TTS audio via ElevenLabs (WAV format)
              logger.info({ voiceId: companyRow.voice_selected_id }, '[manychat/voice] Step 1: ElevenLabs TTS (WAV)');
              const ttsResult = await textToSpeechWav(companyRow.voice_selected_id, result.assistant_message, {
                model: companyRow.voice_model || 'eleven_turbo_v2_5',
                stability: parseFloat(companyRow.voice_stability) || 0.5,
                similarity_boost: parseFloat(companyRow.voice_similarity_boost) || 0.75,
                style: parseFloat(companyRow.voice_style) || 0,
                speaker_boost: companyRow.voice_speaker_boost !== false,
              });
              logger.info({ base64Length: ttsResult.audio_base64.length }, '[manychat/voice] Step 1 OK: WAV audio generated');

              // Step 2: Store attachment in DB
              const audioBuffer = Buffer.from(ttsResult.audio_base64, 'base64');
              const attachment = await chatAttachmentRepository.create(companyId, lead.id, {
                mimeType: 'audio/wav',
                fileName: 'voice-reply.wav',
                byteSize: audioBuffer.length,
                buffer: audioBuffer,
                conversationId: conversation?.id ?? null,
              });
              logger.info({ attachmentId: attachment.id, sizeBytes: audioBuffer.length }, '[manychat/voice] Step 2 OK: attachment saved');

              const baseUrl = (process.env.BACKEND_URL || '').replace(/\/+$/, '');
              const audioPublicUrl = `${baseUrl}/public/attachments/${attachment.id}/${attachment.public_token}/voice-reply.wav`;

              // Step 3: Send voice via ManyChat
              logger.info('[manychat/voice] Step 3: Sending WAV via ManyChat sendContent...');
              try {
                const mcResult = await sendManyChatFile(subscriberId, audioPublicUrl, manychatApiKey);
                logger.info('[manychat/voice] Step 3 OK: Voice sent via sendContent');
                voiceSent = true;
              } catch (mcErr) {
                logger.warn({ status: mcErr.response?.status }, '[manychat/voice] Step 3 FAILED (sendContent)');

                // Fallback: trigger ManyChat flow
                const { sendFlow } = require('../../services/manychatService');
                const voiceReplyStore = require('../../services/voiceReplyStore');
                const flowNs = process.env.MANYCHAT_VOICE_REPLY_FLOW_NS;
                if (flowNs) {
                  voiceReplyStore.set(subscriberId, audioPublicUrl);
                  const flowResult = await sendFlow(subscriberId, flowNs, manychatApiKey);
                  logger.info('[manychat/voice] Step 3b OK: Voice sent via flow');
                  voiceSent = true;
                }
              }
            } catch (voiceErr) {
              const respData = voiceErr.response?.data;
              const respBody = respData instanceof Buffer ? respData.toString('utf8') : JSON.stringify(respData);
              logger.error({ status: voiceErr.response?.status, body: respBody, err: voiceErr.message }, '[manychat/voice] FAILED');
            }
          }

          // Send text reply only if voice was NOT sent (or voice wasn't needed)
          if (!voiceSent) {
            await sendInstagramMessage(subscriberId, result.assistant_message, manychatApiKey);
          }

          incrementMessageCountAndWarn(companyId).catch((err) =>
            logger.warn({ err: err.message }, '[manychat/webhook] message count increment failed')
          );

          // Social proof images (only with text replies, not voice)
          if (!voiceSent) {
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
          }
        } else if (!manychatApiKey) {
          logger.warn({ companyId }, '[manychat/webhook] manychat_api_key not set for company');
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
      logger.error({ err }, '[manychat/webhook] AI reply/suggestions failed');
    } finally {
      await releaseDistributedLock(`lead:${lead.id}`);
    }
  }
  success = true;
  } finally {
    const processingTimeMs = Date.now() - startedAt;
    pool.query(
      `INSERT INTO manychat_webhook_log (company_id, subscriber_id, message_preview, processing_time_ms, success)
       VALUES ($1, $2, $3, $4, $5)`,
      [companyId, subscriberId || null, messagePreview, processingTimeMs, success]
    ).catch((e) => logger.warn({ err: e.message }, '[manychat] webhook log insert failed'));
  }
}

module.exports = router;
module.exports.processManyChatPayload = processManyChatPayload;
