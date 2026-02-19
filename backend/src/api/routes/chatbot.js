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
const { extractFieldsWithClaude } = require('../../chat/extractService');
const { enforceStyle } = require('../../chat/enforceStyle');
const {
  companyInfoBodySchema,
  behaviorBodySchema,
  quoteFieldsBodySchema,
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
    const fields = await chatbotQuoteFieldsRepository.list(req.tenantId);
    res.json({ fields: fields ?? [] });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.put('/quote-fields', async (req, res) => {
  try {
    const parsed = quoteFieldsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return validationError(res, parsed);
    }
    const fields = await chatbotQuoteFieldsRepository.replace(req.tenantId, parsed.data.fields);
    res.json({ fields });
  } catch (err) {
    if (err.code === '23514') {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid type or priority' },
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

    const [behavior, companyInfo, quoteFields] = await Promise.all([
      chatbotBehaviorRepository.get(companyId),
      chatbotCompanyInfoRepository.get(companyId),
      chatbotQuoteFieldsRepository.list(companyId),
    ]);

    const orderedQuoteFields = (quoteFields ?? []).sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    console.info('[chat] loaded quote fields:', orderedQuoteFields.map((f) => ({ name: f.name, type: f.type, required: f.required, priority: f.priority })));

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
    console.info('[chat] conversation_id:', conversationId);

    await chatMessagesRepository.appendMessage(conversationId, 'user', message);

    const { extracted: extractedArr } = await extractFieldsWithClaude(message, orderedQuoteFields);
    console.info('[chat] extractor output:', JSON.stringify(extractedArr));

    for (const item of extractedArr || []) {
      const fieldName = item?.name;
      const fieldDef = orderedQuoteFields.find((f) => f.name === fieldName);
      if (!fieldName || !fieldDef) continue;
      const fieldType = (item?.type || fieldDef?.type || 'text').toLowerCase();
      const fieldTypeSafe = fieldType === 'number' ? 'number' : 'text';
      const value = item?.value;
      if (value != null && String(value).trim() !== '') {
        await chatConversationFieldsRepository.upsertField(conversationId, fieldName, fieldTypeSafe, value);
      }
    }

    const collectedInfos = await chatConversationFieldsRepository.getFields(conversationId, orderedQuoteFields);
    const collectedMap = Object.fromEntries(collectedInfos.map((c) => [c.name, c.value]));

    const requiredFields = orderedQuoteFields.filter((f) => f.required !== false);
    const missingFields = requiredFields
      .filter((f) => {
        const v = collectedMap[f.name];
        return v == null || String(v).trim() === '';
      })
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

    const requiredInfos = missingFields.map((f) => ({
      name: f.name,
      type: f.type,
      units: f.units ?? null,
      priority: f.priority ?? 100,
    }));

    console.info('[chat] required_infos:', requiredInfos);
    console.info('[chat] collected_infos:', collectedInfos);

    if (missingFields.length > 0) {
      const nextField = missingFields[0];
      let assistantMessage = buildFieldQuestion(nextField.name, behavior, nextField.units);
      assistantMessage = enforceStyle(assistantMessage, behavior, { nextRequiredField: nextField.name });
      await chatMessagesRepository.appendMessage(conversationId, 'assistant', assistantMessage);
      console.info('[chat] collector asked for field (no LLM):', nextField.name);
      return res.json({
        assistant_message: assistantMessage,
        conversation_id: conversationId,
        required_infos: requiredInfos,
        collected_infos: collectedInfos,
      });
    }

    console.info('[chat] all fields collected, calling LLM');
    const systemPrompt = buildSystemPrompt(behavior, companyInfo, orderedQuoteFields, collectedMap);
    let assistantMessage = await callLLM(systemPrompt, message, behavior);
    assistantMessage = enforceStyle(assistantMessage, behavior);
    await chatMessagesRepository.appendMessage(conversationId, 'assistant', assistantMessage);

    return res.json({
      assistant_message: assistantMessage,
      conversation_id: conversationId,
      required_infos: [],
      collected_infos: collectedInfos,
    });
  } catch (err) {
    console.error('[chat] error:', err.message);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: err?.message ?? 'Chat failed' },
    });
  }
});

router.get('/conversation/:id/fields', async (req, res) => {
  try {
    const conversationId = req.params.id;
    const companyId = req.tenantId;
    const conv = await chatConversationRepository.getConversation(conversationId, companyId);
    if (!conv) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } });
    }
    const quoteFields = await chatbotQuoteFieldsRepository.list(companyId);
    const orderedQuoteFields = (quoteFields ?? []).sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    const collectedInfos = await chatConversationFieldsRepository.getFields(conversationId, orderedQuoteFields);
    const collectedMap = Object.fromEntries(collectedInfos.map((c) => [c.name, c.value]));
    const requiredFields = orderedQuoteFields.filter((f) => f.required !== false);
    const missingFields = requiredFields
      .filter((f) => {
        const v = collectedMap[f.name];
        return v == null || String(v).trim() === '';
      })
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    const requiredInfos = missingFields.map((f) => ({
      name: f.name,
      type: f.type,
      units: f.units ?? null,
      priority: f.priority ?? 100,
    }));
    return res.json({
      conversation_id: conversationId,
      required_infos: requiredInfos,
      collected_infos: collectedInfos,
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
    const ctx = buildSystemContext(
      companyInfo ?? { website_url: '', business_description: '', additional_notes: '' },
      behavior ?? { tone: 'professional', response_length: 'medium', emojis_enabled: false, persona_style: 'busy', forbidden_topics: [] },
      quoteFields ?? []
    );
    res.json({ systemContext: ctx, system_context: ctx });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

module.exports = router;
