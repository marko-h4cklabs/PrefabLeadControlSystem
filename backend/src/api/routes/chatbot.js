const express = require('express');
const router = express.Router();
const {
  chatbotCompanyInfoRepository,
  chatbotBehaviorRepository,
  chatbotQuoteFieldsRepository,
  chatConversationRepository,
  chatConversationFieldsRepository,
  chatMessagesRepository,
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
    res.json({ fields: presets ?? [] });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.put('/quote-fields', async (req, res) => {
  try {
    const parsed = quotePresetsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return validationError(res, parsed);
    }
    const presets = await chatbotQuoteFieldsRepository.updatePresets(req.tenantId, parsed.data.presets);
    res.json({ fields: presets });
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

    const [behavior, companyInfo, quoteFields] = await Promise.all([
      chatbotBehaviorRepository.get(companyId),
      chatbotCompanyInfoRepository.get(companyId),
      chatbotQuoteFieldsRepository.list(companyId),
    ]);

    const enabledFields = chatbotQuoteFieldsRepository.getEnabledFields(quoteFields ?? []);
    const orderedQuoteFields = enabledFields.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    const quoteFieldMeta = Object.fromEntries(orderedQuoteFields.map((f) => [f.name, { type: f.type, units: f.units }]));

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
    const assistantCountBefore = await chatMessagesRepository.countByRole(conversationId, 'assistant');
    const allowedFieldNames = getAllowedFieldNames(orderedQuoteFields);

    await chatMessagesRepository.appendMessage(conversationId, 'user', message);

    const { extracted: extractedArr } = await extractFieldsWithClaude(message, orderedQuoteFields);
    await chatConversationFieldsRepository.upsertMany(conversationId, extractedArr ?? [], quoteFieldMeta);

    const collectedFromDb = await chatConversationFieldsRepository.getFields(conversationId, orderedQuoteFields);
    const { required_infos: requiredInfos, collected_infos: collectedInfos } = computeFieldsState(
      orderedQuoteFields,
      collectedFromDb
    );
    const collectedMap = Object.fromEntries(collectedInfos.map((c) => [c.name, c.value]));
    const missingFields = requiredInfos;

    console.info('[chat]', {
      companyId,
      conversationId,
      quoteFieldsLoaded: { count: orderedQuoteFields.length, names: orderedQuoteFields.map((f) => f.name) },
      extractionOutput: extractedArr,
      required_infos_length: requiredInfos.length,
      collected_infos_length: collectedInfos.length,
      behaviour: {
        persona_style: behavior?.persona_style,
        response_length: behavior?.response_length,
        emojis_enabled: behavior?.emojis_enabled,
      },
    });

    const highlights = buildHighlights(orderedQuoteFields, collectedInfos, requiredInfos, behavior);

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
      });
    }

    const systemPrompt = buildSystemPrompt(behavior, companyInfo, orderedQuoteFields, collectedMap, []);
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
    const collectedFromDb = await chatConversationFieldsRepository.getFields(conversationId, orderedQuoteFields);
    const { required_infos: requiredInfos, collected_infos: collectedInfos } = computeFieldsState(
      orderedQuoteFields,
      collectedFromDb
    );
    const highlights = buildHighlights(orderedQuoteFields, collectedInfos, requiredInfos, behavior);
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
