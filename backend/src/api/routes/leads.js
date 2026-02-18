const express = require('express');
const router = express.Router({ mergeParams: true });
const { leadRepository, conversationRepository } = require('../../../db/repositories');
const aiReplyService = require('../../../services/aiReplyService');

const VALID_CHANNELS = ['instagram', 'messenger', 'email'];

router.get('/', async (req, res) => {
  try {
    const companyId = req.params.id;
    const { status, limit, offset } = req.query;
    const leads = await leadRepository.findAll(companyId, {
      status: status || undefined,
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });
    const total = await leadRepository.count(companyId, { status: status || undefined });
    res.json({ leads, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const companyId = req.params.id;
    const { channel, external_id } = req.body;
    if (!channel) {
      return res.status(400).json({ error: 'channel is required' });
    }
    if (!VALID_CHANNELS.includes(channel)) {
      return res.status(400).json({ error: 'channel must be one of: instagram, messenger, email' });
    }
    const lead = await leadRepository.create(companyId, {
      channel,
      external_id: external_id ?? null,
    });
    res.status(201).json(lead);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Lead already exists for this channel/external_id' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.get('/:leadId', async (req, res) => {
  try {
    const companyId = req.params.id;
    const lead = await leadRepository.findById(companyId, req.params.leadId);
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    res.json(lead);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:leadId/conversation', async (req, res) => {
  try {
    const companyId = req.params.id;
    const leadId = req.params.leadId;
    const lead = await leadRepository.findById(companyId, leadId);
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
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
    res.status(500).json({ error: err.message });
  }
});

router.post('/:leadId/ai-reply', async (req, res) => {
  try {
    const companyId = req.params.id;
    const leadId = req.params.leadId;
    const lead = await leadRepository.findById(companyId, leadId);
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    const result = await aiReplyService.generateAiReply(companyId, leadId);

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
      return res.status(500).json({ error: 'AI response invalid', details: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

router.post('/:leadId/messages', async (req, res) => {
  try {
    const companyId = req.params.id;
    const leadId = req.params.leadId;
    const { role, content } = req.body;
    const lead = await leadRepository.findById(companyId, leadId);
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    if (!role || !content) {
      return res.status(400).json({ error: 'role and content are required' });
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
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:leadId', async (req, res) => {
  try {
    const companyId = req.params.id;
    const { assigned_sales } = req.body;
    const lead = await leadRepository.update(companyId, req.params.leadId, { assigned_sales });
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    res.json(lead);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
