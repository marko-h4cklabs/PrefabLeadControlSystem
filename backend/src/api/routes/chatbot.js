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

    await chatMessagesRepository.appendMessage(conversationId, 'user', message);

    const extracted = await extractFieldsWithClaude(message, orderedQuoteFields);
    if (Object.keys(extracted).length > 0) {
      console.log('[chat] extracted fields:', extracted);
      for (const [fieldName, obj] of Object.entries(extracted)) {
        const fieldDef = orderedQuoteFields.find((f) => f.name === fieldName);
        const fieldType = (obj?.type || fieldDef?.type || 'text').toLowerCase();
        const fieldTypeSafe = fieldType === 'number' ? 'number' : 'text';
        const value = obj?.value;
        if (value != null && fieldDef) {
          await chatConversationFieldsRepository.upsertField(conversationId, fieldName, fieldTypeSafe, value);
        }
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

    if (missingFields.length > 0) {
      console.log('[chat] missing fields computed:', missingFields.map((f) => f.name));
      const nextField = missingFields[0];
      let assistantMessage = buildFieldQuestion(nextField.name, behavior, nextField.units);
      if (!behavior?.emojis_enabled && /[\u{1F300}-\u{1F9FF}]/u.test(assistantMessage)) {
        assistantMessage = assistantMessage.replace(/[\u{1F300}-\u{1F9FF}]/gu, '').trim();
      }
      await chatMessagesRepository.appendMessage(conversationId, 'assistant', assistantMessage);
      console.log('[chat] collector asked for field (no LLM):', nextField.name);
      return res.json({
        assistant_message: assistantMessage,
        conversation_id: conversationId,
        required_infos: requiredInfos,
        collected_infos: collectedInfos,
      });
    }

    console.log('[chat] all fields collected, calling LLM');
    const systemPrompt = buildSystemPrompt(behavior, companyInfo, orderedQuoteFields, collectedMap);
    let assistantMessage = await callLLM(systemPrompt, message, behavior);
    if (!behavior?.emojis_enabled && /[\u{1F300}-\u{1F9FF}]/u.test(assistantMessage)) {
      assistantMessage = assistantMessage.replace(/[\u{1F300}-\u{1F9FF}]/gu, '').trim();
    }
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
