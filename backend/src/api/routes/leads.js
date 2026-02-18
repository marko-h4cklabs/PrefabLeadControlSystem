const express = require('express');
const router = express.Router({ mergeParams: true });
const { leadRepository, conversationRepository } = require('../../../db/repositories');
const aiReplyService = require('../../../services/aiReplyService');
const { errorJson } = require('../middleware/errors');

const VALID_CHANNELS = ['messenger', 'instagram', 'whatsapp', 'telegram', 'email'];

function normalizeAndValidateChannel(input) {
  const channel = String(input ?? '').trim().toLowerCase();
  if (!channel) return { valid: false, normalized: null };
  if (!VALID_CHANNELS.includes(channel)) return { valid: false, normalized: channel };
  return { valid: true, normalized: channel };
}

router.get('/', async (req, res) => {
  try {
    const { status, limit, offset } = req.query;
    const leads = await leadRepository.findAll(req.tenantId, {
      status: status || undefined,
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });
    const total = await leadRepository.count(req.tenantId, { status: status || undefined });
    res.json({ leads, total });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.post('/', async (req, res) => {
  try {
    const { channel: rawChannel, external_id } = req.body;
    const { valid, normalized } = normalizeAndValidateChannel(rawChannel);
    if (!valid) {
      const msg = normalized ? `Invalid channel: "${rawChannel}". Must be one of: messenger, instagram, whatsapp, telegram, email` : 'channel is required';
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: msg }, allowed: [...VALID_CHANNELS] });
    }
    const lead = await leadRepository.create(req.tenantId, {
      channel: normalized,
      external_id: external_id ?? null,
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

router.get('/:leadId/conversation', async (req, res) => {
  try {
    const leadId = req.params.leadId;
    const lead = await leadRepository.findById(req.tenantId, leadId);
    if (!lead) {
      return errorJson(res, 404, 'NOT_FOUND', 'Lead not found');
    }
    let conversation = await conversationRepository.getByLeadId(leadId);
    if (!conversation) {
      conversation = await conversationRepository.createIfNotExists(leadId);
    }
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
    const { assigned_sales, channel: rawChannel } = req.body;
    const updateData = { assigned_sales };
    if (rawChannel !== undefined) {
      const { valid, normalized } = normalizeAndValidateChannel(rawChannel);
      if (!valid) {
        const msg = normalized ? `Invalid channel: "${rawChannel}". Must be one of: messenger, instagram, whatsapp, telegram, email` : 'channel is required';
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: msg }, allowed: [...VALID_CHANNELS] });
      }
      updateData.channel = normalized;
    }
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
