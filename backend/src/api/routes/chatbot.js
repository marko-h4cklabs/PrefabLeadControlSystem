const express = require('express');
const router = express.Router();
const {
  chatbotCompanyInfoRepository,
  chatbotBehaviorRepository,
  chatbotQuoteFieldsRepository,
  chatConversationRepository,
  chatConversationFieldsRepository,
  chatMessagesRepository,
  schedulingSettingsRepository,
} = require('../../../db/repositories');
const { buildSystemContext } = require('../../services/chatbotSystemContext');
const { buildSystemPrompt, buildFieldQuestion } = require('../../chat/systemPrompt');
const { callLLM } = require('../../chat/chatService');
const { extractFieldsWithClaude, getAllowedFieldNames } = require('../../chat/extractService');
const { enforceStyle } = require('../../chat/enforceStyle');
const { computeFieldsState, buildHighlights } = require('../../chat/fieldsState');
const {
  shouldGreet,
  shouldClose,
  prependGreeting,
  appendClosing,
} = require('../../chat/conversationHelpers');
const { generateGreeting, generateClosing } = require('../../chat/greetingClosingService');
const {
  BOOKING_STATES,
  normalizeConfig,
  isInBookingFlow,
  isBookingAcceptance,
  isBookingDecline,
  buildBookingQuestion,
  looksLikeBookingOffer,
} = require('../../chat/bookingOfferHelper');
const {
  companyInfoBodySchema,
  behaviorBodySchema,
  quotePresetsBodySchema,
} = require('../validators/chatbotSchemas');
const { errorJson } = require('../middleware/errors');

function validationError(res, parsed) {
  return res.status(400).json({
    error: {
      code: 'VALIDATION_ERROR',
      message: parsed.error?.message ?? 'Validation failed',
      details: parsed.error?.flatten?.()?.fieldErrors,
    },
  });
}

function validateEnabledPresetOrder(presets) {
  const enabled = (presets ?? []).filter((p) => p?.is_enabled === true);
  if (enabled.length === 0) return null;
  const priorities = enabled.map((p) => p?.priority);
  const missing = priorities.some((p) => p == null);
  if (missing) return 'Order must be >= 1';
  const hasInvalid = priorities.some((p) => typeof p !== 'number' || !Number.isInteger(p) || p < 1);
  if (hasInvalid) return 'Order must be >= 1';
  const unique = new Set(priorities);
  if (unique.size !== priorities.length) return 'Duplicate order values among enabled presets';
  return null;
}

function quotePresetsValidationError(res, parsed, body) {
  const issues = parsed.error?.issues ?? [];
  const first = issues.find((i) => Array.isArray(i.path) && i.path[0] === 'presets');
  const idx = first?.path?.[1];
  const presetName = idx != null && body?.presets?.[idx] ? body.presets[idx].name : body?.fields?.[idx]?.name ?? null;
  const pathKey = first?.path?.slice(2).join('.') || 'config';
  const msg = presetName
    ? `Preset '${presetName}': invalid ${pathKey}`
    : parsed.error?.message ?? 'Validation failed';
  const cfg = idx != null && (body?.presets?.[idx] ?? body?.fields?.[idx]) ? (body.presets?.[idx] ?? body.fields?.[idx]).config : undefined;
  console.info('[quote-presets] validation failed', { presetName: presetName ?? 'unknown', config: cfg != null ? String(JSON.stringify(cfg)).slice(0, 120) : undefined });
  return res.status(400).json({
    error: { code: 'VALIDATION_ERROR', message: msg, details: parsed.error?.flatten?.()?.fieldErrors },
  });
}

router.get('/company-info', async (req, res) => {
  try {
    const info = await chatbotCompanyInfoRepository.get(req.tenantId);
    res.json({
      website_url: info.website_url ?? '',
      business_description: info.business_description ?? '',
      additional_notes: info.additional_notes ?? '',
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.put('/company-info', async (req, res) => {
  try {
    const parsed = companyInfoBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return validationError(res, parsed);
    }
    const saved = await chatbotCompanyInfoRepository.upsert(req.tenantId, parsed.data);
    res.json({
      website_url: saved.website_url,
      business_description: saved.business_description,
      additional_notes: saved.additional_notes,
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.get('/behavior', async (req, res) => {
  try {
    const behavior = await chatbotBehaviorRepository.get(req.tenantId);
    res.json({
      tone: behavior.tone ?? 'professional',
      response_length: behavior.response_length ?? 'medium',
      emojis_enabled: behavior.emojis_enabled ?? false,
      persona_style: behavior.persona_style ?? 'busy',
      forbidden_topics: behavior.forbidden_topics ?? [],
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.put('/behavior', async (req, res) => {
  try {
    const parsed = behaviorBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return validationError(res, parsed);
    }
    const saved = await chatbotBehaviorRepository.upsert(req.tenantId, parsed.data);
    res.json(saved);
  } catch (err) {
    if (err.code === '23514') {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid enum value for tone, response_length, or persona_style' },
      });
    }
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.get('/quote-fields', async (req, res) => {
  try {
    const presets = await chatbotQuoteFieldsRepository.listAllPresets(req.tenantId);
    res.json({ presets: presets ?? [], fields: presets ?? [] });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.put('/quote-fields', async (req, res) => {
  try {
    const parsed = quotePresetsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return quotePresetsValidationError(res, parsed, req.body);
    }
    const presets = parsed.data?.presets;
    if (!Array.isArray(presets) || presets.length === 0) {
      if (process.env.NODE_ENV !== 'production') {
        console.info('[quote-fields] PUT missing presets array, body keys:', req.body ? Object.keys(req.body) : 'null');
      }
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'presets array required' },
      });
    }
    const { PRESET_NAMES } = require('../validators/chatbotSchemas');
    const unknown = presets.filter((p) => p?.name && !PRESET_NAMES.includes(p.name));
    if (unknown.length > 0) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: `Unknown preset names: ${unknown.map((u) => u.name).join(', ')}. Allowed: ${PRESET_NAMES.join(', ')}`,
        },
      });
    }
    const orderErr = validateEnabledPresetOrder(presets);
    if (orderErr) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: orderErr } });
    }
    const saved = await chatbotQuoteFieldsRepository.updatePresets(req.tenantId, presets);
    res.json({ presets: saved, fields: saved });
  } catch (err) {
    if (err.code === '23514') {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid preset config' },
      });
    }
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.post('/quote-fields', (req, res) => {
  res.status(403).json({
    error: { code: 'FORBIDDEN', message: 'Custom field creation is disabled. Use preset settings only.' },
  });
});

router.get('/quote-presets', async (req, res) => {
  try {
    const presets = await chatbotQuoteFieldsRepository.listAllPresets(req.tenantId);
    res.json({ presets: presets ?? [], fields: presets ?? [] });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.put('/quote-presets', async (req, res) => {
  try {
    const parsed = quotePresetsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return quotePresetsValidationError(res, parsed, req.body);
    }
    const presets = parsed.data?.presets;
    if (!Array.isArray(presets) || presets.length === 0) {
      console.info('[quote-presets] invalid payload', req.body);
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'presets array required' },
      });
    }
    const { PRESET_NAMES } = require('../validators/chatbotSchemas');
    const unknown = presets.filter((p) => p?.name && !PRESET_NAMES.includes(p.name));
    if (unknown.length > 0) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: `Unknown preset names: ${unknown.map((u) => u.name).join(', ')}. Allowed: ${PRESET_NAMES.join(', ')}`,
        },
      });
    }
    const orderErr = validateEnabledPresetOrder(presets);
    if (orderErr) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: orderErr } });
    }
    const saved = await chatbotQuoteFieldsRepository.updatePresets(req.tenantId, presets);
    res.json({ presets: saved, fields: saved });
  } catch (err) {
    if (err.code === '23514') {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid preset config' },
      });
    }
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

const chatBodySchema = require('../validators/chatSchemas').chatBodySchema;

router.post('/chat', async (req, res) => {
  try {
    const parsed = chatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: parsed.error?.message ?? 'message is required' },
      });
    }
    const { message, conversationId: reqConversationId } = parsed.data;
    const companyId = req.tenantId;

    const [behavior, companyInfo, quoteFields, schedulingConfig] = await Promise.all([
      chatbotBehaviorRepository.get(companyId),
      chatbotCompanyInfoRepository.get(companyId),
      chatbotQuoteFieldsRepository.list(companyId),
      schedulingSettingsRepository.get(companyId).catch((err) => {
        console.error('[chat] SCHEDULING CONFIG LOAD FAILED:', err.message, { companyId, code: err.code, detail: err.detail });
        return null;
      }),
    ]);
    if (!schedulingConfig) {
      console.warn('[chat] schedulingConfig is NULL — booking offers will not trigger', { companyId });
    }

    const enabledFields = chatbotQuoteFieldsRepository.getEnabledFields(quoteFields ?? []);
    const orderedQuoteFields = enabledFields.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

    let conversation;
    if (reqConversationId) {
      conversation = await chatConversationRepository.getConversation(reqConversationId, companyId);
      if (!conversation) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } });
      }
    } else {
      conversation = await chatConversationRepository.getOrCreateActiveConversation(companyId);
    }
    const conversationId = conversation.id;

    let fieldsForChat = orderedQuoteFields;
    const snapshot = conversation.quote_snapshot;
    if (snapshot != null && Array.isArray(snapshot) && snapshot.length > 0) {
      fieldsForChat = snapshot.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    } else {
      const snapshotData = orderedQuoteFields.map((f) => ({
        name: f.name,
        type: f.type,
        units: f.units ?? null,
        priority: f.priority ?? 100,
        required: f.required !== false,
        is_enabled: true,
        config: f.config ?? {},
      }));
      await chatConversationRepository.updateQuoteSnapshot(conversationId, companyId, snapshotData);
    }
    const orderedQuoteFieldsForChat = fieldsForChat;
    const quoteFieldMeta = Object.fromEntries(orderedQuoteFieldsForChat.map((f) => [f.name, { type: f.type, units: f.units }]));
    const assistantCountBefore = await chatMessagesRepository.countByRole(conversationId, 'assistant');
    const allowedFieldNames = getAllowedFieldNames(orderedQuoteFieldsForChat);

    await chatMessagesRepository.appendMessage(conversationId, 'user', message);

    const { extracted: extractedArr } = await extractFieldsWithClaude(message, orderedQuoteFieldsForChat);
    await chatConversationFieldsRepository.upsertMany(conversationId, extractedArr ?? [], quoteFieldMeta);

    const collectedFromDb = await chatConversationFieldsRepository.getFields(conversationId, orderedQuoteFieldsForChat);
    const { required_infos: requiredInfos, collected_infos: collectedInfos } = computeFieldsState(
      orderedQuoteFieldsForChat,
      collectedFromDb
    );
    const collectedMap = Object.fromEntries(collectedInfos.map((c) => [c.name, c.value]));
    const missingFields = requiredInfos;

    console.info('[chat]', {
      companyId,
      conversationId,
      quoteFieldsLoaded: { count: orderedQuoteFieldsForChat.length, names: orderedQuoteFieldsForChat.map((f) => f.name) },
      extractionOutput: extractedArr,
      required_infos_length: requiredInfos.length,
      collected_infos_length: collectedInfos.length,
      behaviour: {
        persona_style: behavior?.persona_style,
        response_length: behavior?.response_length,
        emojis_enabled: behavior?.emojis_enabled,
      },
    });

    const highlights = buildHighlights(orderedQuoteFieldsForChat, collectedInfos, requiredInfos, behavior);

    const quoteComplete = missingFields.length === 0;
    const bkgConfig = normalizeConfig(schedulingConfig);
    const bookingActive = bkgConfig
      && bkgConfig.bookingOffersEnabled
      && bkgConfig.bookingMode !== 'off';
    const hasName = !!(collectedMap.full_name || collectedMap.name || collectedMap.fullName);
    const hasPhone = !!(collectedMap.phone || collectedMap.phone_number || collectedMap.phoneNumber);

    const convState = await chatConversationRepository.getOrCreateState(conversationId, companyId);
    const bookingPhase = convState.last_asked_field || null;

    let bookingSkipReason = null;
    if (!bkgConfig) bookingSkipReason = 'config_null';
    else if (!bkgConfig.bookingOffersEnabled) bookingSkipReason = 'booking_offers_disabled';
    else if (bkgConfig.bookingMode === 'off') bookingSkipReason = 'mode_off';
    else if (!bkgConfig.askAfterQuote) bookingSkipReason = 'ask_after_quote_off';
    else if (!quoteComplete) bookingSkipReason = 'quote_not_complete';
    else if (isInBookingFlow(bookingPhase)) bookingSkipReason = 'already_in_booking_flow';

    const bookingDebug = {
      eligible: bookingActive && quoteComplete && (bkgConfig?.askAfterQuote ?? false) && !isInBookingFlow(bookingPhase),
      offered: false,
      reason: bookingSkipReason || 'eligible',
      missing_required: missingFields.map((f) => f.name),
      scheduling_enabled: bkgConfig?.schedulingEnabled ?? false,
      booking_offers_enabled: bkgConfig?.bookingOffersEnabled ?? false,
      booking_mode: bkgConfig?.bookingMode ?? 'n/a',
      ask_after_quote: bkgConfig?.askAfterQuote ?? false,
      require_name: bkgConfig?.requireName ?? false,
      require_phone: bkgConfig?.requirePhone ?? false,
      has_name: hasName,
      has_phone: hasPhone,
      booking_phase: bookingPhase,
      config_loaded: schedulingConfig != null,
    };

    console.info('[booking-offer] settings normalized:', JSON.stringify(bkgConfig));
    console.info('[booking-offer] missingRequired:', missingFields.map((f) => f.name));
    console.info('[booking-offer] bookingOfferSent:', isInBookingFlow(bookingPhase));
    console.info('[booking-offer] decision:', bookingDebug.eligible ? 'OFFER' : `SKIP reason=${bookingSkipReason}`);

    // ---- Booking prerequisite follow-ups ----
    if (bookingPhase === BOOKING_STATES.PREREQ_NAME && quoteComplete && bookingActive) {
      await chatConversationFieldsRepository.upsertField(conversationId, 'full_name', 'text', message.trim());
      if (bkgConfig.requirePhone && !hasPhone) {
        const ask = 'Could you also share your phone number?';
        await chatConversationRepository.updateState(conversationId, companyId, { last_asked_field: BOOKING_STATES.PREREQ_PHONE });
        await chatMessagesRepository.appendMessage(conversationId, 'assistant', ask);
        bookingDebug.offered = false; bookingDebug.reason = 'prereq_phone_needed';
        console.info('[booking-offer] name stored, asking phone', { conversationId });
        return res.json({ assistant_message: ask, conversation_id: conversationId, highlights, booking_debug: bookingDebug });
      }
      const question = buildBookingQuestion(bkgConfig);
      await chatConversationRepository.updateState(conversationId, companyId, { last_asked_field: BOOKING_STATES.OFFERED });
      await chatMessagesRepository.appendMessage(conversationId, 'assistant', question);
      bookingDebug.offered = true; bookingDebug.reason = 'offered_after_name_prereq';
      console.info('[booking-offer] OFFERED after name prereq', { conversationId });
      return res.json({
        assistant_message: question, conversation_id: conversationId, highlights,
        booking_offer: true, quick_replies: ['Yes', 'Not now'], booking_debug: bookingDebug,
      });
    }

    if (bookingPhase === BOOKING_STATES.PREREQ_PHONE && quoteComplete && bookingActive) {
      await chatConversationFieldsRepository.upsertField(conversationId, 'phone_number', 'text', message.trim());
      const question = buildBookingQuestion(bkgConfig);
      await chatConversationRepository.updateState(conversationId, companyId, { last_asked_field: BOOKING_STATES.OFFERED });
      await chatMessagesRepository.appendMessage(conversationId, 'assistant', question);
      bookingDebug.offered = true; bookingDebug.reason = 'offered_after_phone_prereq';
      console.info('[booking-offer] OFFERED after phone prereq', { conversationId });
      return res.json({
        assistant_message: question, conversation_id: conversationId, highlights,
        booking_offer: true, quick_replies: ['Yes', 'Not now'], booking_debug: bookingDebug,
      });
    }

    // ---- Booking offer response handling (user replied to "would you like to schedule?") ----
    if (bookingPhase === BOOKING_STATES.OFFERED && quoteComplete) {
      if (isBookingAcceptance(message)) {
        const ack = bkgConfig?.allowCustomTime
          ? 'When works best for you? Please share your preferred date and time, and our team will confirm.'
          : 'Our team will reach out shortly to schedule a convenient time. Thank you!';
        await chatConversationRepository.updateState(conversationId, companyId, { last_asked_field: BOOKING_STATES.ACCEPTED });
        await chatMessagesRepository.appendMessage(conversationId, 'assistant', ack);
        bookingDebug.offered = true; bookingDebug.reason = 'booking_accepted';
        console.info('[booking-offer] ACCEPTED', { conversationId });
        return res.json({ assistant_message: ack, conversation_id: conversationId, highlights, booking_accepted: true, booking_debug: bookingDebug });
      }
      if (isBookingDecline(message)) {
        const decline = 'No problem! Our team has your information and will follow up if needed. Thank you!';
        await chatConversationRepository.updateState(conversationId, companyId, { last_asked_field: BOOKING_STATES.DECLINED });
        await chatMessagesRepository.appendMessage(conversationId, 'assistant', decline);
        bookingDebug.offered = false; bookingDebug.reason = 'booking_declined';
        console.info('[booking-offer] DECLINED', { conversationId });
        return res.json({ assistant_message: decline, conversation_id: conversationId, highlights, booking_declined: true, booking_debug: bookingDebug });
      }
    }

    // ---- Standard quote collection branch ----
    if (missingFields.length > 0) {
      const nextField = missingFields[0];
      let assistantMessage = buildFieldQuestion(nextField.name, behavior, nextField.units);
      assistantMessage = enforceStyle(assistantMessage, behavior, {
        nextRequiredField: nextField.name,
        topMissingField: nextField,
        allowedFieldNames,
      });
      if (shouldGreet(assistantCountBefore)) {
        const greetingWords = await generateGreeting(message, behavior);
        assistantMessage = prependGreeting(assistantMessage, greetingWords);
      }
      await chatMessagesRepository.appendMessage(conversationId, 'assistant', assistantMessage);
      return res.json({
        assistant_message: assistantMessage,
        conversation_id: conversationId,
        highlights,
        booking_debug: bookingDebug,
      });
    }

    // ---- Quote complete: first-time booking offer ----
    if (quoteComplete && bookingActive && bkgConfig.askAfterQuote && !isInBookingFlow(bookingPhase)) {
      const systemPrompt = buildSystemPrompt(behavior, companyInfo, orderedQuoteFieldsForChat, collectedMap, [], schedulingConfig);
      let assistantMessage = await callLLM(systemPrompt, message, behavior);
      assistantMessage = enforceStyle(assistantMessage, behavior, { allowedFieldNames });
      if (shouldGreet(assistantCountBefore)) {
        const greetingWords = await generateGreeting(message, behavior);
        assistantMessage = prependGreeting(assistantMessage, greetingWords);
      }

      if (bkgConfig.requireName && !hasName) {
        assistantMessage += '\n\nTo proceed with scheduling, could you share your full name?';
        await chatConversationRepository.updateState(conversationId, companyId, { last_asked_field: BOOKING_STATES.PREREQ_NAME });
        await chatMessagesRepository.appendMessage(conversationId, 'assistant', assistantMessage);
        bookingDebug.offered = false; bookingDebug.reason = 'prereq_name_needed';
        console.info('[booking-offer] summary + asking name prereq', { conversationId });
        return res.json({ assistant_message: assistantMessage, conversation_id: conversationId, highlights, booking_debug: bookingDebug });
      }

      if (bkgConfig.requirePhone && !hasPhone) {
        assistantMessage += '\n\nTo proceed with scheduling, could you share your phone number?';
        await chatConversationRepository.updateState(conversationId, companyId, { last_asked_field: BOOKING_STATES.PREREQ_PHONE });
        await chatMessagesRepository.appendMessage(conversationId, 'assistant', assistantMessage);
        bookingDebug.offered = false; bookingDebug.reason = 'prereq_phone_needed';
        console.info('[booking-offer] summary + asking phone prereq', { conversationId });
        return res.json({ assistant_message: assistantMessage, conversation_id: conversationId, highlights, booking_debug: bookingDebug });
      }

      if (!looksLikeBookingOffer(assistantMessage)) {
        const bookingQ = buildBookingQuestion(bkgConfig);
        assistantMessage += '\n\n' + bookingQ;
      }

      await chatConversationRepository.updateState(conversationId, companyId, { last_asked_field: BOOKING_STATES.OFFERED });
      await chatMessagesRepository.appendMessage(conversationId, 'assistant', assistantMessage);
      bookingDebug.offered = true; bookingDebug.reason = 'offered_with_summary';
      console.info('[booking-offer] OFFERED with summary', { conversationId });
      return res.json({
        assistant_message: assistantMessage, conversation_id: conversationId, highlights,
        booking_offer: true, quick_replies: ['Yes', 'Not now'], booking_debug: bookingDebug,
      });
    }

    // ---- Default: LLM with scheduling-aware prompt (post-booking or booking disabled) ----
    const systemPrompt = buildSystemPrompt(behavior, companyInfo, orderedQuoteFieldsForChat, collectedMap, [], schedulingConfig);
    let assistantMessage = await callLLM(systemPrompt, message, behavior);
    assistantMessage = enforceStyle(assistantMessage, behavior, { allowedFieldNames });
    if (shouldGreet(assistantCountBefore)) {
      const greetingWords = await generateGreeting(message, behavior);
      assistantMessage = prependGreeting(assistantMessage, greetingWords);
    }
    if (shouldClose(message, [])) {
      const closingWords = await generateClosing(message, collectedMap, behavior);
      assistantMessage = appendClosing(assistantMessage, closingWords);
    }
    await chatMessagesRepository.appendMessage(conversationId, 'assistant', assistantMessage);

    return res.json({
      assistant_message: assistantMessage,
      conversation_id: conversationId,
      highlights,
      booking_debug: bookingDebug,
    });
  } catch (err) {
    console.error('[chat] error:', err.message);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: err?.message ?? 'Chat failed' },
    });
  }
});

router.get('/conversation/:conversationId/fields', async (req, res) => {
  try {
    const conversationId = req.params.conversationId;
    const companyId = req.tenantId;
    const conv = await chatConversationRepository.getConversation(conversationId, companyId);
    if (!conv) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } });
    }
    const [quoteFields, behavior] = await Promise.all([
      chatbotQuoteFieldsRepository.list(companyId),
      chatbotBehaviorRepository.get(companyId),
    ]);
    const enabledFields = chatbotQuoteFieldsRepository.getEnabledFields(quoteFields ?? []);
    const orderedQuoteFields = enabledFields.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    let fieldsForChat = orderedQuoteFields;
    const snapshot = conv.quote_snapshot;
    if (snapshot != null && Array.isArray(snapshot) && snapshot.length > 0) {
      fieldsForChat = snapshot.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    }
    const collectedFromDb = await chatConversationFieldsRepository.getFields(conversationId, fieldsForChat);
    const { required_infos: requiredInfos, collected_infos: collectedInfos } = computeFieldsState(
      fieldsForChat,
      collectedFromDb
    );
    const highlights = buildHighlights(fieldsForChat, collectedInfos, requiredInfos, behavior);
    return res.json({
      conversation_id: conversationId,
      required_infos: requiredInfos,
      collected_infos: collectedInfos,
      highlights,
    });
  } catch (err) {
    console.error('[chat] fields error:', err.message);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: err?.message ?? 'Failed' },
    });
  }
});

router.get('/system-context', async (req, res) => {
  try {
    const [companyInfo, behavior, quoteFields] = await Promise.all([
      chatbotCompanyInfoRepository.get(req.tenantId),
      chatbotBehaviorRepository.get(req.tenantId),
      chatbotQuoteFieldsRepository.list(req.tenantId),
    ]);
    const enabledFields = chatbotQuoteFieldsRepository.getEnabledFields(quoteFields ?? []);
    const ctx = buildSystemContext(
      companyInfo ?? { website_url: '', business_description: '', additional_notes: '' },
      behavior ?? { tone: 'professional', response_length: 'medium', emojis_enabled: false, persona_style: 'busy', forbidden_topics: [] },
      enabledFields
    );
    res.json({ systemContext: ctx, system_context: ctx });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

module.exports = router;
