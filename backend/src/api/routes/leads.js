const express = require('express');
const router = express.Router({ mergeParams: true });
const {
  leadRepository,
  conversationRepository,
  chatbotQuoteFieldsRepository,
} = require('../../../db/repositories');
const aiReplyService = require('../../../services/aiReplyService');
const { computeFieldsState } = require('../../chat/fieldsState');
const { errorJson } = require('../middleware/errors');
const {
  VALID_CHANNELS,
  VALID_STATUSES,
  listLeadsQuerySchema,
  createLeadBodySchema,
  updateLeadBodySchema,
} = require('../validators/leadSchemas');

function normalizeAndValidateChannel(input) {
  const channel = String(input ?? '').trim().toLowerCase();
  if (!channel) return { valid: false, normalized: null };
  if (!VALID_CHANNELS.includes(channel)) return { valid: false, normalized: channel };
  return { valid: true, normalized: channel };
}

router.get('/', async (req, res) => {
  try {
    const parsed = listLeadsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid query parameters',
          details: parsed.error.flatten().fieldErrors,
        },
      });
    }
    const { limit, offset, status, statusId, status_id } = parsed.data;
    const filterStatusId = statusId || status_id;
    const leads = await leadRepository.findAll(req.tenantId, {
      status,
      status_id: filterStatusId,
      limit,
      offset,
    });
    const total = await leadRepository.count(req.tenantId, { status, status_id: filterStatusId });
    res.json({ leads, total });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.post('/', async (req, res) => {
  try {
    const parsed = createLeadBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const err = parsed.error.flatten();
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: err.formErrors?.join?.(' ') || 'Validation failed',
          details: err.fieldErrors,
        },
      });
    }
    const { channel, external_id } = parsed.data;
    const lead = await leadRepository.create(req.tenantId, {
      channel,
      external_id,
    });
    res.status(201).json(lead);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: { code: 'CONFLICT', message: 'Lead already exists for this channel/external_id' } });
    }
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.get('/:leadId', async (req, res) => {
  try {
    const lead = await leadRepository.findById(req.tenantId, req.params.leadId);
    if (!lead) {
      return errorJson(res, 404, 'NOT_FOUND', 'Lead not found');
    }
    res.json(lead);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

function parsedFieldsToCollected(parsedFields, quoteFields) {
  const quoteByName = Object.fromEntries((quoteFields ?? []).map((f) => [f.name, f]));
  return Object.entries(parsedFields ?? {})
    .filter(([, v]) => v != null && String(v).trim() !== '')
    .map(([name, value]) => {
      const qf = quoteByName[name];
      return {
        name,
        value,
        type: qf?.type ?? 'text',
        units: qf?.units ?? null,
        priority: qf?.priority ?? 100,
      };
    });
}

router.get('/:leadId/conversation', async (req, res) => {
  try {
    const leadId = req.params.leadId;
    const companyId = req.tenantId;
    const lead = await leadRepository.findById(companyId, leadId);
    if (!lead) {
      return errorJson(res, 404, 'NOT_FOUND', 'Lead not found');
    }
    let conversation = await conversationRepository.getByLeadId(leadId);
    if (!conversation) {
      conversation = await conversationRepository.createIfNotExists(leadId);
    }
    const quoteFields = await chatbotQuoteFieldsRepository.list(companyId);
    const orderedQuoteFields = (quoteFields ?? [])
      .filter((f) => ['text', 'number'].includes(f.type))
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    const collectedFromParsed = parsedFieldsToCollected(conversation.parsed_fields, orderedQuoteFields);
    const { required_infos, collected_infos } = computeFieldsState(orderedQuoteFields, collectedFromParsed);
    res.json({
      lead_id: leadId,
      messages: conversation.messages,
      parsed_fields: conversation.parsed_fields,
      current_step: conversation.current_step,
      required_infos: required_infos ?? [],
      collected_infos: collected_infos ?? [],
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.post('/:leadId/ai-reply', async (req, res) => {
  try {
    const leadId = req.params.leadId;
    const lead = await leadRepository.findById(req.tenantId, leadId);
    if (!lead) {
      return errorJson(res, 404, 'NOT_FOUND', 'Lead not found');
    }
    const result = await aiReplyService.generateAiReply(req.tenantId, leadId);

    await conversationRepository.appendMessage(leadId, 'assistant', result.assistant_message);

    let conversation = await conversationRepository.getByLeadId(leadId);
    const currentParsed = conversation.parsed_fields ?? {};
    const merged = { ...currentParsed };
    for (const [key, value] of Object.entries(result.field_updates ?? {})) {
      const isNonEmpty =
        value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '');
      if (isNonEmpty) {
        merged[key] = value;
      }
    }
    const hasChanges =
      Object.keys(merged).length !== Object.keys(currentParsed).length ||
      JSON.stringify(merged) !== JSON.stringify(currentParsed);
    if (hasChanges) {
      await conversationRepository.updateParsedFields(leadId, merged);
    }

    conversation = await conversationRepository.getByLeadId(leadId);
    res.json({
      lead_id: leadId,
      messages: conversation.messages,
      parsed_fields: conversation.parsed_fields,
      current_step: conversation.current_step,
      required_infos: result.required_infos ?? [],
      collected_infos: result.collected_infos ?? [],
      highlights: result.highlights ?? null,
    });
  } catch (err) {
    if (err.message?.includes('Invalid JSON') || err.message?.includes('assistant_message') || err.message?.includes('field_updates')) {
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'AI response invalid', details: err.message } });
    }
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.post('/:leadId/messages', async (req, res) => {
  try {
    const leadId = req.params.leadId;
    const { role, content } = req.body;
    const lead = await leadRepository.findById(req.tenantId, leadId);
    if (!lead) {
      return errorJson(res, 404, 'NOT_FOUND', 'Lead not found');
    }
    if (!role || !content) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'role and content are required' } });
    }
    let conversation = await conversationRepository.getByLeadId(leadId);
    if (!conversation) {
      conversation = await conversationRepository.createIfNotExists(leadId);
    }
    conversation = await conversationRepository.appendMessage(leadId, role, content);
    res.json({
      lead_id: leadId,
      messages: conversation.messages,
      parsed_fields: conversation.parsed_fields,
      current_step: conversation.current_step,
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.patch('/:leadId', async (req, res) => {
  try {
    const parsed = updateLeadBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const err = parsed.error.flatten();
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: err.formErrors?.join?.(' ') || 'Validation failed',
          details: err.fieldErrors,
        },
      });
    }
    const updateData = {};
    if (parsed.data.status !== undefined) updateData.status = parsed.data.status;
    if (parsed.data.assigned_sales !== undefined) updateData.assigned_sales = parsed.data.assigned_sales;
    if (parsed.data.channel !== undefined) updateData.channel = parsed.data.channel;
    const lead = await leadRepository.update(req.tenantId, req.params.leadId, updateData);
    if (!lead) {
      return errorJson(res, 404, 'NOT_FOUND', 'Lead not found');
    }
    res.json(lead);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

module.exports = router;
