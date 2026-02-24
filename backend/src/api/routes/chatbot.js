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
  schedulingRequestRepository,
  companyRepository,
} = require('../../../db/repositories');
const { buildSystemContext } = require('../../services/chatbotSystemContext');
const { buildSystemPrompt: buildSystemPromptLegacy, buildFieldQuestion } = require('../../chat/systemPrompt');
const { buildSystemPrompt, buildLeadContext } = require('../../services/systemPromptBuilder');
const { validateAndCleanReply } = require('../../services/replyValidator');
const { claudeWithRetry } = require('../../utils/claudeWithRetry');
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
  isTerminalBookingState,
  isBookingAcceptance,
  isBookingDecline,
  looksLikeBookingIntent,
  buildBookingQuestion,
  looksLikeBookingOffer,
  formatSlotsMessage,
  buildBookingPayload,
} = require('../../chat/bookingOfferHelper');
const { getAvailability } = require('../../../services/availabilityService');
const { evaluateBookingTrigger } = require('../../../services/bookingTriggerService');
const {
  companyInfoBodySchema,
  behaviorBodySchema,
  quotePresetsBodySchema,
} = require('../validators/chatbotSchemas');
const { errorJson } = require('../middleware/errors');
const { pool } = require('../../../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

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

const personaRouter = require('./chatbotPersonas');
const templateRouter = require('./chatbotTemplates');
router.use('/personas', personaRouter);
router.use('/templates', templateRouter);

router.get('/identity', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const [behavior, companyRecord, companyInfo] = await Promise.all([
      chatbotBehaviorRepository.get(companyId),
      companyRepository.findById(companyId),
      chatbotCompanyInfoRepository.get(companyId),
    ]);
    res.json({
      agent_name: behavior?.agent_name ?? '',
      agent_backstory: behavior?.agent_backstory ?? '',
      business_name: companyRecord?.name ?? '',
      business_description: companyInfo?.business_description ?? '',
      additional_context: companyInfo?.additional_notes ?? '',
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.put('/identity', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { agent_name, agent_backstory, business_name, business_description, additional_context } = req.body ?? {};
    await chatbotBehaviorRepository.upsert(companyId, { agent_name: agent_name ?? undefined, agent_backstory: agent_backstory ?? undefined });
    if (business_name !== undefined || business_description !== undefined || additional_context !== undefined) {
      if (business_name !== undefined) {
        await pool.query('UPDATE companies SET name = COALESCE($1, name) WHERE id = $2', [business_name || null, companyId]);
      }
      await chatbotCompanyInfoRepository.upsert(companyId, {
        business_description: business_description !== undefined ? business_description : undefined,
        additional_notes: additional_context !== undefined ? additional_context : undefined,
      });
    }
    res.json({ success: true });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.get('/guardrails', async (req, res) => {
  try {
    const behavior = await chatbotBehaviorRepository.get(req.tenantId);
    res.json({
      bot_deny_response: behavior?.bot_deny_response ?? '',
      prohibited_topics: behavior?.prohibited_topics ?? '',
      handoff_trigger: behavior?.handoff_trigger ?? '',
      human_fallback_message: behavior?.human_fallback_message ?? '',
      max_messages_before_handoff: behavior?.max_messages_before_handoff ?? 20,
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.put('/guardrails', async (req, res) => {
  try {
    const { bot_deny_response, prohibited_topics, handoff_trigger, human_fallback_message, max_messages_before_handoff } = req.body ?? {};
    await chatbotBehaviorRepository.upsert(req.tenantId, {
      bot_deny_response: bot_deny_response ?? undefined,
      prohibited_topics: prohibited_topics ?? undefined,
      handoff_trigger: handoff_trigger ?? undefined,
      human_fallback_message: human_fallback_message ?? undefined,
      max_messages_before_handoff: max_messages_before_handoff ?? undefined,
    });
    res.json({ success: true });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.get('/strategy', async (req, res) => {
  try {
    const behavior = await chatbotBehaviorRepository.get(req.tenantId);
    res.json({
      primary_goal: behavior?.conversation_goal ?? '',
      follow_up_style: behavior?.follow_up_style ?? 'gentle',
      closing_style: behavior?.closing_style ?? 'soft',
      competitor_mentions: behavior?.competitor_mentions ?? 'deflect',
      price_reveal: behavior?.price_reveal ?? 'ask_first',
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.put('/strategy', async (req, res) => {
  try {
    const { primary_goal, follow_up_style, closing_style, competitor_mentions, price_reveal } = req.body ?? {};
    await chatbotBehaviorRepository.upsert(req.tenantId, {
      conversation_goal: primary_goal ?? undefined,
      follow_up_style: follow_up_style ?? undefined,
      closing_style: closing_style ?? undefined,
      competitor_mentions: competitor_mentions ?? undefined,
      price_reveal: price_reveal ?? undefined,
    });
    res.json({ success: true });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.get('/social-proof', async (req, res) => {
  try {
    const behavior = await chatbotBehaviorRepository.get(req.tenantId);
    res.json({
      enabled: behavior?.social_proof_enabled ?? false,
      examples: behavior?.social_proof_examples ?? '',
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.put('/social-proof', async (req, res) => {
  try {
    const { enabled, examples } = req.body ?? {};
    await chatbotBehaviorRepository.upsert(req.tenantId, {
      social_proof_enabled: enabled ?? undefined,
      social_proof_examples: examples ?? undefined,
    });
    res.json({ success: true });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.get('/social-proof-images', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const result = await pool.query(
      'SELECT id, url, caption, send_when_asked FROM social_proof_images WHERE company_id = $1 ORDER BY created_at ASC',
      [companyId]
    );
    res.json({ images: result.rows || [] });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.post('/social-proof-images', upload.single('image'), async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { caption, url: bodyUrl } = req.body || {};

    let url = bodyUrl;

    if (req.file) {
      const dir = path.join(__dirname, '../../../public/uploads/social-proof');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const filename = `${companyId}_${Date.now()}_${(req.file.originalname || 'image').replace(/[^a-zA-Z0-9.]/g, '_')}`;
      fs.writeFileSync(path.join(dir, filename), req.file.buffer);
      const backendUrl = process.env.BACKEND_URL || process.env.RAILWAY_STATIC_URL || 'http://localhost:3000';
      url = `${backendUrl.replace(/\/+$/, '')}/uploads/social-proof/${filename}`;
    }

    if (!url || !String(url).trim()) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Image file or URL required' } });
    }

    const result = await pool.query(
      'INSERT INTO social_proof_images (id, company_id, url, caption) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id, url, caption, send_when_asked, created_at',
      [companyId, String(url).trim(), (caption || '').trim()]
    );
    res.json(result.rows[0]);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.delete('/social-proof-images/:id', async (req, res) => {
  try {
    const companyId = req.tenantId;
    await pool.query('DELETE FROM social_proof_images WHERE id = $1 AND company_id = $2', [
      req.params.id,
      companyId,
    ]);
    res.json({ success: true });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

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
    res.json(behavior);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.get('/behavior/preview', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const [companyRecord, companyInfo, behavior, quoteFields, personaRow, socialProofImagesRows] = await Promise.all([
      companyRepository.findById(companyId),
      chatbotCompanyInfoRepository.get(companyId),
      chatbotBehaviorRepository.get(companyId),
      chatbotQuoteFieldsRepository.list(companyId),
      pool.query(
        'SELECT id, name, system_prompt, agent_name, tone, opener_style FROM chatbot_personas WHERE company_id = $1 AND is_active = true LIMIT 1',
        [companyId]
      ).then((r) => r.rows[0] ?? null),
      pool.query('SELECT id, url, caption, send_when_asked FROM social_proof_images WHERE company_id = $1 ORDER BY created_at ASC', [companyId]).then((r) => r.rows || []),
    ]);
    const company = {
      name: companyRecord?.name || 'our company',
      business_description: companyInfo?.business_description ?? '',
      additional_notes: companyInfo?.additional_notes ?? '',
    };
    const prompt = await buildSystemPrompt(company, behavior, quoteFields, personaRow, socialProofImagesRows || []);
    res.json({ prompt });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.post('/behavior/test', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const message = req.body?.message;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'message (string) is required' } });
    }
    const [companyRecord, companyInfo, behavior, quoteFields, personaRow, socialProofImagesRows] = await Promise.all([
      companyRepository.findById(companyId),
      chatbotCompanyInfoRepository.get(companyId),
      chatbotBehaviorRepository.get(companyId),
      chatbotQuoteFieldsRepository.list(companyId),
      pool.query(
        'SELECT id, name, system_prompt, agent_name, tone, opener_style FROM chatbot_personas WHERE company_id = $1 AND is_active = true LIMIT 1',
        [companyId]
      ).then((r) => r.rows[0] ?? null),
      pool.query('SELECT id, url, caption, send_when_asked FROM social_proof_images WHERE company_id = $1 ORDER BY created_at ASC', [companyId]).then((r) => r.rows || []),
    ]);
    const company = {
      name: companyRecord?.name || 'our company',
      business_description: companyInfo?.business_description ?? '',
      additional_notes: companyInfo?.additional_notes ?? '',
    };
    const prompt = await buildSystemPrompt(company, behavior, quoteFields, personaRow, socialProofImagesRows || []);
    const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
    const { content, provider } = await claudeWithRetry({
      model,
      max_tokens: 1024,
      system: prompt + '\n\nRespond naturally as the sales rep. One short reply only. No JSON.',
      messages: [{ role: 'user', content: message.trim() }],
    });
    const reply = validateAndCleanReply(content ?? '', behavior);
    res.json({
      reply,
      provider: provider || 'claude',
      prompt_preview: prompt.slice(0, 500) + (prompt.length > 500 ? '...' : ''),
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

router.get('/booking-settings', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const [behavior, companyRow] = await Promise.all([
      chatbotBehaviorRepository.get(companyId),
      pool.query('SELECT calendly_url FROM companies WHERE id = $1', [companyId]).then((r) => r.rows[0]),
    ]);
    res.json({
      booking_trigger_enabled: behavior?.booking_trigger_enabled ?? false,
      booking_trigger_score: behavior?.booking_trigger_score ?? 60,
      booking_platform: behavior?.booking_platform ?? 'google_calendar',
      calendly_url: behavior?.calendly_url ?? companyRow?.calendly_url ?? '',
      booking_offer_message: behavior?.booking_offer_message ?? '',
      booking_required_fields: Array.isArray(behavior?.booking_required_fields) ? behavior.booking_required_fields : ['full_name', 'email_address'],
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.put('/booking-settings', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const {
      booking_trigger_enabled,
      booking_trigger_score,
      booking_platform,
      calendly_url,
      booking_offer_message,
      booking_required_fields,
    } = req.body ?? {};
    await chatbotBehaviorRepository.upsert(companyId, {
      booking_trigger_enabled,
      booking_trigger_score,
      booking_platform,
      calendly_url,
      booking_offer_message,
      booking_required_fields: Array.isArray(booking_required_fields) ? booking_required_fields : undefined,
    });
    if (calendly_url !== undefined) {
      await pool.query('UPDATE companies SET calendly_url = $1 WHERE id = $2', [calendly_url ?? null, companyId]);
    }
    res.json({ success: true });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.get('/quote-fields', async (req, res) => {
  try {
    const fields = await chatbotQuoteFieldsRepository.listWithCustom(req.tenantId);
    res.json({ presets: fields ?? [], fields: fields ?? [] });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.post('/quote-fields/custom', async (req, res) => {
  try {
    const { label, field_type = 'text' } = req.body ?? {};
    if (!label || !String(label).trim()) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Label is required' } });
    }
    const created = await chatbotQuoteFieldsRepository.createCustom(req.tenantId, {
      label: String(label).trim(),
      field_type: String(field_type || 'text').trim(),
    });
    res.status(201).json(created);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.delete('/quote-fields/:id', async (req, res) => {
  try {
    const deleted = await chatbotQuoteFieldsRepository.deleteCustomById(req.tenantId, req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Custom field not found' } });
    }
    res.json({ success: true });
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
    const { message, conversationId: reqConversationId, leadId: reqLeadId } = parsed.data;
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
      companyId, conversationId,
      quoteFieldsLoaded: { count: orderedQuoteFieldsForChat.length, names: orderedQuoteFieldsForChat.map((f) => f.name) },
      extractionOutput: extractedArr,
      required_infos_length: requiredInfos.length,
      collected_infos_length: collectedInfos.length,
    });

    const highlights = buildHighlights(orderedQuoteFieldsForChat, collectedInfos, requiredInfos, behavior);
    const quoteComplete = missingFields.length === 0;
    const bkgConfig = normalizeConfig(schedulingConfig);
    const bookingActive = bkgConfig && bkgConfig.bookingOffersEnabled && bkgConfig.bookingMode !== 'off';
    const hasName = !!(collectedMap.full_name || collectedMap.name || collectedMap.fullName);
    const hasPhone = !!(collectedMap.phone || collectedMap.phone_number || collectedMap.phoneNumber);

    let bookingPhase = null;
    let bookingState = null;
    let stateLoadFailed = false;
    try {
      const convState = await chatConversationRepository.getOrCreateState(conversationId, companyId);
      bookingPhase = convState.last_asked_field || null;
      const fields = convState.collected_fields || {};
      bookingState = fields.__booking || null;
    } catch (stateErr) {
      stateLoadFailed = true;
      console.error('[chat-booking] STATE LOAD FAILED:', stateErr.message, { companyId, conversationId, code: stateErr.code });
    }

    // Reset terminal states for new explicit booking intent
    if (!stateLoadFailed && isTerminalBookingState(bookingPhase)) {
      if (looksLikeBookingIntent(message)) {
        console.info('[chat-booking] resetting terminal state for new intent', { conversationId, was: bookingPhase });
        try { await chatConversationRepository.updateState(conversationId, companyId, { last_asked_field: null }); } catch (_) {}
        bookingPhase = null;
      }
    }

    const userWantsBooking = looksLikeBookingIntent(message);

    // Count assistant messages since last booking offer for cooldown
    let assistantCountSinceOffer = 0;
    if (bookingState?.offeredAt) {
      try {
        assistantCountSinceOffer = await chatMessagesRepository.countAssistantSince(conversationId, bookingState.offeredAt);
      } catch (_) { assistantCountSinceOffer = 999; }
    }

    // Centralized booking trigger evaluation
    const trigger = evaluateBookingTrigger({
      quoteComplete,
      bookingPhase,
      bookingState,
      bkgConfig,
      bookingActive,
      stateLoadFailed,
      userMessage: message,
      assistantCountSinceOffer,
    });

    const bookingDebug = {
      _v: '2026-02-22-v5',
      eligible: trigger.shouldOfferBooking,
      offered: false,
      reason: trigger.reason,
      missing_required: missingFields.map((f) => f.name),
      booking_offers_enabled: bkgConfig?.bookingOffersEnabled ?? false,
      scheduling_enabled: bkgConfig?.schedulingEnabled ?? false,
      booking_mode: bkgConfig?.bookingMode ?? 'n/a',
      ask_after_quote: bkgConfig?.askAfterQuote ?? false,
      require_name: bkgConfig?.requireName ?? false,
      require_phone: bkgConfig?.requirePhone ?? false,
      has_name: hasName, has_phone: hasPhone,
      booking_phase: bookingPhase,
      config_loaded: schedulingConfig != null,
      state_load_failed: stateLoadFailed,
      user_wants_booking: userWantsBooking,
      quote_complete: quoteComplete,
      trigger_result: trigger,
      assistant_msgs_since_offer: assistantCountSinceOffer,
    };

    // Apply dismiss patch if evaluateBookingTrigger flagged it
    if (trigger.bookingStatePatch && trigger.reason === 'user_dismissing') {
      try {
        await chatConversationRepository.updateBookingState(conversationId, companyId, trigger.bookingStatePatch);
        await chatConversationRepository.updateState(conversationId, companyId, { last_asked_field: BOOKING_STATES.DECLINED });
        bookingPhase = BOOKING_STATES.DECLINED;
      } catch (_) {}
    }

    let selectedReplyPath = 'generic_ai';

    console.info(`[chat-booking] conv=${conversationId} trigger=${trigger.reason} shouldOffer=${trigger.shouldOfferBooking} phase=${bookingPhase} quoteComplete=${quoteComplete} msgsSinceOffer=${assistantCountSinceOffer}`);

    const collectedInfosForResponse = collectedInfos.map((c) => ({
      name: c.name, type: c.type ?? 'text', value: c.value, units: c.units ?? null,
      ...(c.links && { links: c.links }),
    }));
    const requiredInfosForResponse = requiredInfos.map((r) => ({
      name: r.name, type: r.type ?? 'text', units: r.units ?? null, priority: r.priority ?? 100,
    }));

    function respond(assistantMessage, extra = {}) {
      bookingDebug.selectedReplyPath = selectedReplyPath;
      const { ui_action, booking, ...rest } = extra;
      console.info(`[chat-booking] REPLY path=${selectedReplyPath} conv=${conversationId} phase=${bookingPhase}`);

      const bookingMeta = booking || (bookingActive ? {
        enabled: true,
        flowStatus: bookingPhase || 'none',
        bookingMode: bkgConfig?.bookingMode ?? 'manual_request',
        requiresName: bkgConfig?.requireName ?? false,
        requiresPhone: bkgConfig?.requirePhone ?? false,
        source: 'chatbot',
      } : null);

      const meta = {};
      if (bookingMeta) {
        meta.booking = {
          offered: bookingDebug.offered,
          stage: bookingPhase || 'idle',
          canShowSlots: bkgConfig?.showSlots ?? false,
          slots: bookingMeta.slots || bookingMeta.availableSlots || [],
          actions: buildBookingActions(bookingPhase, bkgConfig),
          ...bookingMeta,
        };
      }

      const bookingFlow = {
        offered: !!(bookingState?.offeredAt) || bookingDebug.offered,
        offered_at: bookingState?.offeredAt || null,
        offer_reason: bookingState?.offerSource || (bookingDebug.offered ? trigger.reason : null),
        awaiting_slot_selection: bookingPhase === BOOKING_STATES.SLOTS_SHOWN,
        slots_last_shown_at: bookingState?.offeredAt || null,
        dismissed: !!(bookingState?.dismissed),
        dismissed_at: bookingState?.dismissedAt || null,
        booked_appointment_id: bookingState?.completedAppointmentId || null,
      };

      return res.json({
        assistant_message: assistantMessage,
        conversation_id: conversationId,
        highlights,
        required_infos: requiredInfosForResponse,
        collected_infos: collectedInfosForResponse,
        booking_debug: bookingDebug,
        booking_flow: bookingFlow,
        ui_action: ui_action || null,
        booking: bookingMeta,
        meta,
        ...rest,
      });
    }

    function buildBookingActions(phase, cfg) {
      if (!cfg) return [];
      const actions = [];
      if (phase === BOOKING_STATES.OFFERED) {
        actions.push({ type: 'booking_accept', label: 'Yes, book a call' });
        actions.push({ type: 'booking_decline', label: 'Later' });
        if (cfg.allowCustomTime) {
          actions.push({ type: 'booking_custom_time', label: 'Propose another time' });
        }
      } else if (phase === BOOKING_STATES.SLOTS_SHOWN) {
        actions.push({ type: 'booking_custom_time', label: 'Propose another time' });
      } else if (phase === BOOKING_STATES.CONFIRMED || phase === BOOKING_STATES.ACCEPTED) {
        actions.push({ type: 'booking_done', label: 'Done' });
      }
      return actions;
    }

    // ====== BOOKING ORCHESTRATION (all booking state handlers) ======
    // Wrapped in try/catch: if any booking operation fails, fall back to generic AI
    try {

    // ========= BOOKING PREREQ: name =========
    if (bookingPhase === BOOKING_STATES.PREREQ_NAME && bookingActive) {
      selectedReplyPath = 'booking_collect_prereq';
      await chatConversationFieldsRepository.upsertField(conversationId, 'full_name', 'text', message.trim());
      if (bkgConfig.requirePhone && !hasPhone) {
        const ask = 'Could you also share your phone number?';
        await chatConversationRepository.updateState(conversationId, companyId, { last_asked_field: BOOKING_STATES.PREREQ_PHONE });
        await chatMessagesRepository.appendMessage(conversationId, 'assistant', ask);
        bookingDebug.reason = 'prereq_phone_needed';
        return respond(ask, { ui_action: 'booking_collect_prereq', booking: buildBookingPayload('offer', { requiredBeforeBooking: ['phone_number'], missingPrereqs: ['phone_number'] }) });
      }
      const question = buildBookingQuestion(bkgConfig);
      await chatConversationRepository.updateState(conversationId, companyId, { last_asked_field: BOOKING_STATES.OFFERED });
      await chatMessagesRepository.appendMessage(conversationId, 'assistant', question);
      bookingDebug.offered = true; bookingDebug.reason = 'offered_after_name_prereq';
      return respond(question, { ui_action: 'booking_offer', booking: buildBookingPayload('offer'), booking_offer: true, quick_replies: ['Yes', 'Not now'] });
    }

    // ========= BOOKING PREREQ: phone =========
    if (bookingPhase === BOOKING_STATES.PREREQ_PHONE && bookingActive) {
      selectedReplyPath = 'booking_collect_prereq';
      await chatConversationFieldsRepository.upsertField(conversationId, 'phone_number', 'text', message.trim());
      const question = buildBookingQuestion(bkgConfig);
      await chatConversationRepository.updateState(conversationId, companyId, { last_asked_field: BOOKING_STATES.OFFERED });
      await chatMessagesRepository.appendMessage(conversationId, 'assistant', question);
      bookingDebug.offered = true; bookingDebug.reason = 'offered_after_phone_prereq';
      return respond(question, { ui_action: 'booking_offer', booking: buildBookingPayload('offer'), booking_offer: true, quick_replies: ['Yes', 'Not now'] });
    }

    // ========= BOOKING RESPONSE: user replied to offer =========
    if (bookingPhase === BOOKING_STATES.OFFERED) {
      if (isBookingAcceptance(message)) {
        selectedReplyPath = 'booking_slots';
        try {
          const availability = await getAvailability(companyId, { limit: 5 });
          const slots = availability.slots || [];
          if (slots.length > 0) {
            const slotsText = formatSlotsMessage(slots, 5);
            const ask = slotsText + '\n\nPlease pick a time, or suggest your own.';
            await chatConversationRepository.updateState(conversationId, companyId, { last_asked_field: BOOKING_STATES.SLOTS_SHOWN });
            await chatConversationRepository.updateBookingState(conversationId, companyId, {
              offeredSlots: slots, offeredAt: new Date().toISOString(),
            });
            await chatMessagesRepository.appendMessage(conversationId, 'assistant', ask);
            bookingDebug.offered = true; bookingDebug.reason = 'slots_shown';
            console.info('[chat-booking] SLOTS_SHOWN', { conversationId, slotCount: slots.length });
            return respond(ask, { ui_action: 'booking_slots', booking: buildBookingPayload('slots', { slots, availableSlots: slots }) });
          }

          // No slots — transition to manual request flow
          selectedReplyPath = 'booking_manual_request';
          if (bkgConfig.allowCustomTime) {
            const noSlots = "I couldn't find available slots in that range. I can still take your preferred day/time and submit a booking request. When would work best for you?";
            await chatConversationRepository.updateState(conversationId, companyId, { last_asked_field: BOOKING_STATES.CUSTOM_TIME });
            await chatMessagesRepository.appendMessage(conversationId, 'assistant', noSlots);
            bookingDebug.reason = 'no_slots_custom_time';
            console.info('[chat-booking] no slots, asking custom time', { conversationId, debug: availability.debug });
            return respond(noSlots, { ui_action: 'booking_collect_time', booking: buildBookingPayload('awaiting_custom_time', { debug: availability.debug }) });
          }

          const noSlotsFallback = 'Our team will reach out shortly to find a time that works. Thank you!';
          await chatConversationRepository.updateState(conversationId, companyId, { last_asked_field: BOOKING_STATES.ACCEPTED });
          await chatMessagesRepository.appendMessage(conversationId, 'assistant', noSlotsFallback);
          bookingDebug.reason = 'no_slots_team_followup';
          return respond(noSlotsFallback, { ui_action: 'booking_manual_request', booking: buildBookingPayload('not_available', { debug: availability.debug }) });
        } catch (availErr) {
          console.error('[chat-booking] availability fetch failed, using manual fallback:', availErr.message);
          selectedReplyPath = 'booking_manual_request';
          if (bkgConfig.allowCustomTime) {
            const fallback = 'When would work best for you? Share your preferred date and time, and our team will arrange it.';
            await chatConversationRepository.updateState(conversationId, companyId, { last_asked_field: BOOKING_STATES.CUSTOM_TIME });
            await chatMessagesRepository.appendMessage(conversationId, 'assistant', fallback);
            bookingDebug.reason = 'availability_error_manual_fallback';
            return respond(fallback, { ui_action: 'booking_collect_time', booking: buildBookingPayload('awaiting_custom_time') });
          }
          const fallback = 'Our team will contact you to schedule a convenient time. Thank you!';
          await chatConversationRepository.updateState(conversationId, companyId, { last_asked_field: BOOKING_STATES.ACCEPTED });
          await chatMessagesRepository.appendMessage(conversationId, 'assistant', fallback);
          bookingDebug.reason = 'availability_error';
          return respond(fallback, { ui_action: 'booking_manual_request', booking: buildBookingPayload('not_available') });
        }
      }
      if (isBookingDecline(message)) {
        selectedReplyPath = 'booking_declined';
        const decline = 'No problem! Our team has your information and will follow up if needed. Thank you!';
        await chatConversationRepository.updateState(conversationId, companyId, { last_asked_field: BOOKING_STATES.DECLINED });
        await chatConversationRepository.updateBookingState(conversationId, companyId, { declined: true, declinedAt: new Date().toISOString() });
        await chatMessagesRepository.appendMessage(conversationId, 'assistant', decline);
        bookingDebug.reason = 'booking_declined';
        console.info('[chat-booking] DECLINED', { conversationId });
        return respond(decline, { ui_action: 'booking_declined', booking: buildBookingPayload('declined'), booking_declined: true });
      }
    }

    // ========= SLOTS_SHOWN: user replied after seeing slots =========
    if (bookingPhase === BOOKING_STATES.SLOTS_SHOWN) {
      selectedReplyPath = 'booking_slot_selection';
      const numMatch = message.trim().match(/^(\d)$/);
      if (numMatch) {
        const idx = parseInt(numMatch[1], 10) - 1;
        const bkState = await chatConversationRepository.getBookingState(conversationId, companyId);
        const offeredSlots = bkState?.offeredSlots || [];
        if (idx >= 0 && idx < offeredSlots.length) {
          const slot = offeredSlots[idx];
          await chatConversationRepository.updateBookingState(conversationId, companyId, { selectedSlot: slot });
          const confirm = `You selected: ${slot.label}. To confirm this booking, say "confirm".`;
          await chatMessagesRepository.appendMessage(conversationId, 'assistant', confirm);
          return respond(confirm, {
            ui_action: 'booking_confirm',
            booking: buildBookingPayload('slots', { slots: offeredSlots, selectedSlot: slot, conversationId, leadId: reqLeadId || null }),
          });
        }
      }
      if (/\b(confirm|book it|yes|da)\b/i.test(message)) {
        const bkState = await chatConversationRepository.getBookingState(conversationId, companyId);
        if (bkState?.selectedSlot) {
          const { isSlotAvailable } = require('../../../services/availabilityService');
          const slot = bkState.selectedSlot;
          const available = await isSlotAvailable(companyId, slot.startAt, slot.endAt);
          if (available && reqLeadId) {
            const { appointmentRepository, leadRepository } = require('../../../db/repositories');
            const lead = await leadRepository.findById(companyId, reqLeadId);
            const leadName = lead?.name || 'Lead';
            const typeLabel = (bkgConfig.defaultType || 'call').replace(/_/g, ' ');
            const appointment = await appointmentRepository.create({
              companyId, leadId: reqLeadId,
              title: `${typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)} - ${leadName}`,
              appointmentType: bkgConfig.defaultType || 'call',
              status: 'scheduled',
              startAt: slot.startAt, endAt: slot.endAt,
              timezone: bkgConfig.timezone || 'Europe/Zagreb',
              source: 'chatbot', reminderMinutesBefore: 60,
            });
            await chatConversationRepository.updateState(conversationId, companyId, { last_asked_field: BOOKING_STATES.CONFIRMED });
            await chatConversationRepository.updateBookingState(conversationId, companyId, {
              completedAppointmentId: appointment.id, confirmedAt: new Date().toISOString(),
            });
            selectedReplyPath = 'booking_confirmed';
            const confirmMsg = `Your ${typeLabel} has been confirmed for ${slot.label}. We look forward to speaking with you!`;
            await chatMessagesRepository.appendMessage(conversationId, 'assistant', confirmMsg);
            const warmingService = require('../../services/warmingService');
            warmingService.enrollLead(reqLeadId, companyId, 'call_booked').catch((err) => console.error('[chat-booking] warming enroll error:', err.message));
            const googleCalendarService = require('../../services/googleCalendarService');
            googleCalendarService.syncNewAppointmentToGoogle(companyId, appointment, lead).catch((err) => console.error('[chat-booking] Google sync:', err.message));
            console.info('[chat-booking] CONFIRMED via chat', { conversationId, appointmentId: appointment.id });
            return respond(confirmMsg, { ui_action: 'booking_success', booking: buildBookingPayload('confirmed', { appointment, appointmentId: appointment.id }) });
          }
          // No leadId or slot taken — create scheduling request instead
          if (available && !reqLeadId) {
            selectedReplyPath = 'booking_manual_request';
            await chatConversationRepository.updateState(conversationId, companyId, { last_asked_field: BOOKING_STATES.ACCEPTED });
            await chatConversationRepository.updateBookingState(conversationId, companyId, { requestedSlot: slot, requestedAt: new Date().toISOString() });
            const ack = `Your request for ${slot.label} has been noted. Our team will confirm shortly.`;
            await chatMessagesRepository.appendMessage(conversationId, 'assistant', ack);
            return respond(ack, { ui_action: 'booking_manual_request', booking: buildBookingPayload('requested', { requestedSlot: slot }) });
          }
          const retry = 'That slot is no longer available. Please pick another time.';
          await chatMessagesRepository.appendMessage(conversationId, 'assistant', retry);
          return respond(retry, { ui_action: 'booking_slots', booking: buildBookingPayload('slots', { slots: bkState.offeredSlots || [] }) });
        }
      }
      // Fall through to LLM for anything else while in slots state
    }

    // ========= CUSTOM_TIME: user proposed a time — create booking request =========
    if (bookingPhase === BOOKING_STATES.CUSTOM_TIME) {
      selectedReplyPath = 'booking_manual_request';
      await chatConversationRepository.updateState(conversationId, companyId, { last_asked_field: BOOKING_STATES.ACCEPTED });
      await chatConversationRepository.updateBookingState(conversationId, companyId, {
        customTimeRequest: message.trim(), requestedAt: new Date().toISOString(),
      });

      let createdRequest = null;
      if (reqLeadId) {
        try {
          createdRequest = await schedulingRequestRepository.create({
            companyId,
            leadId: reqLeadId,
            conversationId,
            source: 'chatbot',
            status: 'open',
            requestType: bkgConfig.defaultType || 'call',
            preferredTimezone: bkgConfig.timezone || 'Europe/Zagreb',
            notes: `Preferred time: ${message.trim()}`,
            availabilityMode: 'manual',
            metadata: { conversationId, customTimeText: message.trim() },
          });
          console.info('[chat-booking] scheduling request created', { conversationId, requestId: createdRequest?.id });
        } catch (srErr) {
          console.warn('[chat-booking] scheduling request create failed (non-blocking):', srErr.message);
        }
      }

      const ack = 'Thank you! Your preferred time has been submitted. Our team will review and confirm shortly.';
      await chatMessagesRepository.appendMessage(conversationId, 'assistant', ack);
      bookingDebug.reason = 'custom_time_received';
      return respond(ack, {
        ui_action: 'booking_manual_request',
        booking: buildBookingPayload('requested', { schedulingRequestId: createdRequest?.id ?? null }),
      });
    }

    // ========= UNIFIED BOOKING OFFER: triggered by evaluateBookingTrigger =========
    // Only fires when trigger.shouldOfferBooking is true (explicit intent OR auto-after-quote)
    // This single block replaces both the "explicit intent" and "auto-after-quote" paths.
    if (trigger.shouldOfferBooking) {
      selectedReplyPath = trigger.reason === 'user_intent' ? 'booking_intent_entry' : 'booking_offer';
      console.info('[chat-booking] OFFERING booking', { conversationId, reason: trigger.reason, quoteComplete });

      const missing = [];
      if (bkgConfig.requireName && !hasName) missing.push('full_name');
      if (bkgConfig.requirePhone && !hasPhone) missing.push('phone_number');

      if (missing.length > 0) {
        selectedReplyPath = 'booking_collect_prereq';
        const first = missing[0];
        const askLabel = first === 'full_name' ? 'your full name' : 'your phone number';
        const prereqMsg = trigger.reason === 'user_intent'
          ? `Sure! To schedule that, could you share ${askLabel}?`
          : `To proceed with scheduling, could you share ${askLabel}?`;
        const phase = first === 'full_name' ? BOOKING_STATES.PREREQ_NAME : BOOKING_STATES.PREREQ_PHONE;
        await chatConversationRepository.updateState(conversationId, companyId, { last_asked_field: phase });
        if (trigger.bookingStatePatch) {
          await chatConversationRepository.updateBookingState(conversationId, companyId, trigger.bookingStatePatch);
        }
        await chatMessagesRepository.appendMessage(conversationId, 'assistant', prereqMsg);
        bookingDebug.reason = `prereq_${first}_needed`;
        return respond(prereqMsg, { ui_action: 'booking_collect_prereq', booking: buildBookingPayload('offer', { requiredBeforeBooking: missing, missingPrereqs: missing, source: trigger.reason }) });
      }

      // Fetch slots if requested
      let offerSlots = [];
      if (trigger.shouldFetchSlots) {
        try {
          const avail = await getAvailability(companyId, { limit: 5 });
          offerSlots = avail.slots || [];
        } catch (slErr) {
          console.warn('[chat-booking] slot fetch failed (non-blocking):', slErr.message);
        }
      }

      // Build the offer message
      let offerMsg = '';
      if (trigger.reason === 'auto_after_quote' && quoteComplete) {
        try {
          const systemPrompt = buildSystemPromptLegacy(behavior, companyInfo, orderedQuoteFieldsForChat, collectedMap, [], schedulingConfig);
          offerMsg = await callLLM(systemPrompt, message, behavior);
          offerMsg = enforceStyle(offerMsg, behavior, { allowedFieldNames });
          if (shouldGreet(assistantCountBefore)) {
            const greetingWords = await generateGreeting(message, behavior);
            offerMsg = prependGreeting(offerMsg, greetingWords);
          }
        } catch (llmErr) {
          console.warn('[chat-booking] LLM summary failed, using simple offer:', llmErr.message);
        }
      }

      if (offerSlots.length > 0) {
        const slotsText = formatSlotsMessage(offerSlots, 5);
        offerMsg = (offerMsg ? offerMsg + '\n\n' : '') + slotsText + '\n\nPick a time, or suggest your own!';
      } else if (!offerMsg || !looksLikeBookingOffer(offerMsg)) {
        offerMsg = (offerMsg ? offerMsg + '\n\n' : '') + buildBookingQuestion(bkgConfig);
      }

      const offerPhase = offerSlots.length > 0 ? BOOKING_STATES.SLOTS_SHOWN : BOOKING_STATES.OFFERED;
      await chatConversationRepository.updateState(conversationId, companyId, { last_asked_field: offerPhase });
      await chatConversationRepository.updateBookingState(conversationId, companyId, {
        ...(trigger.bookingStatePatch || {}),
        offeredAt: new Date().toISOString(),
        offerSource: trigger.reason,
        dismissed: false,
        ...(offerSlots.length > 0 ? { offeredSlots: offerSlots } : {}),
      });
      bookingPhase = offerPhase;
      await chatMessagesRepository.appendMessage(conversationId, 'assistant', offerMsg);
      bookingDebug.offered = true;
      bookingDebug.reason = trigger.reason;
      console.info('[chat-booking] OFFERED', { conversationId, reason: trigger.reason, slotsCount: offerSlots.length });
      return respond(offerMsg, {
        ui_action: offerSlots.length > 0 ? 'booking_slots' : 'booking_offer',
        booking: buildBookingPayload(offerSlots.length > 0 ? 'slots' : 'offer', {
          source: trigger.reason,
          defaultAppointmentType: bkgConfig.defaultType,
          slots: offerSlots,
          availableSlots: offerSlots,
        }),
        booking_offer: true,
        quick_replies: offerSlots.length > 0 ? [] : ['Yes', 'Not now'],
      });
    }

    // ========= SLOT REFRESH: user asked "another time", "more slots" etc. =========
    if (trigger.isSlotRefresh && bookingPhase === BOOKING_STATES.SLOTS_SHOWN) {
      try {
        const avail = await getAvailability(companyId, { limit: 5 });
        const refreshSlots = avail.slots || [];
        if (refreshSlots.length > 0) {
          const slotsText = formatSlotsMessage(refreshSlots, 5);
          const refreshMsg = slotsText + '\n\nPick a time, or suggest your own!';
          await chatConversationRepository.updateBookingState(conversationId, companyId, { offeredSlots: refreshSlots });
          await chatMessagesRepository.appendMessage(conversationId, 'assistant', refreshMsg);
          return respond(refreshMsg, { ui_action: 'booking_slots', booking: buildBookingPayload('slots', { slots: refreshSlots, availableSlots: refreshSlots }) });
        }
      } catch (slErr) {
        console.warn('[chat-booking] slot refresh failed:', slErr.message);
      }
    }

    } catch (bookingOrchErr) {
      console.error('[chat-booking] orchestration error, falling back to generic AI:', bookingOrchErr.message, bookingOrchErr.stack?.split('\n')[1]);
      selectedReplyPath = 'generic_ai_fallback';
      bookingDebug.reason = 'orchestration_error';
      bookingDebug.error = bookingOrchErr.message;
    }

    // ========= Standard quote collection =========
    if (missingFields.length > 0) {
      selectedReplyPath = 'quote_question';
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
      return respond(assistantMessage);
    }

    // ========= Default: LLM response (post-booking or booking disabled) =========
    if (selectedReplyPath !== 'generic_ai' && selectedReplyPath !== 'generic_ai_fallback') {
      console.warn('[chat] unexpected fallthrough: selectedReplyPath=%s, returning generic AI anyway', selectedReplyPath);
    }
    selectedReplyPath = selectedReplyPath === 'generic_ai_fallback' ? 'generic_ai_fallback' : 'generic_ai';
    const systemPrompt = buildSystemPromptLegacy(behavior, companyInfo, orderedQuoteFieldsForChat, collectedMap, [], schedulingConfig);
    let assistantMessage = await callLLM(systemPrompt, message, behavior);
    assistantMessage = enforceStyle(assistantMessage, behavior, { allowedFieldNames });
    if (shouldGreet(assistantCountBefore)) {
      const greetingWords = await generateGreeting(message, behavior);
      assistantMessage = prependGreeting(assistantMessage, greetingWords);
    }

    // If booking SHOULD have been offered but fell back due to error, append booking question
    if (bookingActive && quoteComplete && !stateLoadFailed && bkgConfig.askAfterQuote
        && !isInBookingFlow(bookingPhase) && selectedReplyPath === 'generic_ai_fallback') {
      console.warn('[chat-booking] injecting booking CTA into fallback response');
      assistantMessage += '\n\n' + buildBookingQuestion(bkgConfig);
      bookingDebug.reason = 'fallback_with_booking_cta';
      try { await chatConversationRepository.updateState(conversationId, companyId, { last_asked_field: BOOKING_STATES.OFFERED }); } catch (_) {}
    }

    const shouldAddClosing = !bookingActive || isTerminalBookingState(bookingPhase);
    if (shouldAddClosing && shouldClose(message, [])) {
      const closingWords = await generateClosing(message, collectedMap, behavior);
      assistantMessage = appendClosing(assistantMessage, closingWords);
    }
    await chatMessagesRepository.appendMessage(conversationId, 'assistant', assistantMessage);
    return respond(assistantMessage);
  } catch (err) {
    console.error('[chat] error:', err.message, err.stack?.split('\n')[1]);
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

/**
 * Diagnostic endpoint — verifies the entire booking pipeline works
 * for the authenticated company. Returns DB state, table existence,
 * normalized config, and sample availability.
 */
router.get('/booking-diagnostic', async (req, res) => {
  const companyId = req.tenantId;
  const diag = { _v: '2026-02-22-v4', companyId, checks: {} };

  // 1. Scheduling settings from DB
  try {
    const raw = await schedulingSettingsRepository.get(companyId);
    const norm = normalizeConfig(raw);
    diag.checks.schedulingSettings = {
      ok: true,
      raw_keys: Object.keys(raw || {}),
      chatbotOfferBooking: raw?.chatbotOfferBooking,
      chatbot_offer_booking: raw?.chatbot_offer_booking,
      enabled: raw?.enabled,
      scheduling_enabled: raw?.scheduling_enabled,
    };
    diag.checks.normalizedConfig = {
      ok: !!norm,
      bookingOffersEnabled: norm?.bookingOffersEnabled,
      schedulingEnabled: norm?.schedulingEnabled,
      bookingMode: norm?.bookingMode,
      askAfterQuote: norm?.askAfterQuote,
      requireName: norm?.requireName,
      requirePhone: norm?.requirePhone,
      showSlots: norm?.showSlots,
      allowCustomTime: norm?.allowCustomTime,
    };
    diag.checks.bookingActive = !!(norm && norm.bookingOffersEnabled && norm.bookingMode !== 'off');
  } catch (err) {
    diag.checks.schedulingSettings = { ok: false, error: err.message, code: err.code };
    diag.checks.normalizedConfig = { ok: false, error: 'depends on settings' };
  }

  // 2. chat_conversation_state table exists
  try {
    const { pool } = require('../../../db/index');
    await pool.query('SELECT 1 FROM chat_conversation_state LIMIT 0');
    diag.checks.stateTable = { ok: true, table: 'chat_conversation_state' };
  } catch (err) {
    diag.checks.stateTable = { ok: false, error: err.message, code: err.code, hint: 'Run migration 010_chat_conversation_state.sql' };
  }

  // 3. company_scheduling_settings table + chatbot columns exist
  try {
    const { pool } = require('../../../db/index');
    const colCheck = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'company_scheduling_settings' AND column_name LIKE 'chatbot_%' ORDER BY ordinal_position`
    );
    diag.checks.schedulingTable = {
      ok: colCheck.rows.length > 0,
      chatbot_columns: colCheck.rows.map(r => r.column_name),
      hint: colCheck.rows.length === 0 ? 'Run migration 030' : null,
    };
  } catch (err) {
    diag.checks.schedulingTable = { ok: false, error: err.message };
  }

  // 4. Availability engine
  try {
    const avail = await getAvailability(companyId, { limit: 3 });
    diag.checks.availability = {
      ok: true,
      slotCount: avail.slots.length,
      slots: avail.slots.slice(0, 3),
      debug: avail.debug,
    };
  } catch (err) {
    diag.checks.availability = { ok: false, error: err.message };
  }

  // 5. Active conversations with booking state
  try {
    const { pool } = require('../../../db/index');
    const convs = await pool.query(
      `SELECT cs.conversation_id, cs.last_asked_field, cs.collected_fields->>'__booking' as booking_state, cs.updated_at
       FROM chat_conversation_state cs
       WHERE cs.company_id = $1
       ORDER BY cs.updated_at DESC LIMIT 5`,
      [companyId]
    );
    diag.checks.recentConversationStates = {
      ok: true,
      count: convs.rows.length,
      conversations: convs.rows.map(r => ({
        id: r.conversation_id,
        bookingPhase: r.last_asked_field,
        bookingState: r.booking_state ? JSON.parse(r.booking_state) : null,
        updatedAt: r.updated_at,
      })),
    };
  } catch (err) {
    diag.checks.recentConversationStates = { ok: false, error: err.message };
  }

  const allOk = Object.values(diag.checks).every(c => c.ok);
  diag.overall = allOk ? 'ALL_CHECKS_PASSED' : 'SOME_CHECKS_FAILED';
  diag.failedChecks = Object.entries(diag.checks).filter(([, v]) => !v.ok).map(([k]) => k);

  return res.json(diag);
});

module.exports = router;
