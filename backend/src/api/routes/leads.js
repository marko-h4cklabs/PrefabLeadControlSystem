const express = require('express');
const router = express.Router({ mergeParams: true });
const {
  leadRepository,
  conversationRepository,
  chatbotBehaviorRepository,
  chatbotQuoteFieldsRepository,
  companyLeadStatusesRepository,
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
  patchNameBodySchema,
  patchStatusBodySchema,
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
    const { limit, offset, status, statusId, status_id, query } = parsed.data;
    let filterStatusId = statusId || status_id;
    if (filterStatusId === 'all' || filterStatusId === '__ALL__') {
      filterStatusId = null;
    }
    const leads = await leadRepository.findAll(req.tenantId, {
      status,
      status_id: filterStatusId,
      query,
      limit,
      offset,
    });
    const total = await leadRepository.count(req.tenantId, { status, status_id: filterStatusId, query });
    const leadsWithSummary = await Promise.all(
      (leads ?? []).map(async (l) => {
        const base = {
          id: l.id,
          channel: l.channel,
          name: l.name ?? l.external_id ?? null,
          status_id: l.status_id ?? null,
          status_name: l.status_name ?? l.status ?? null,
          created_at: l.created_at,
          updated_at: l.updated_at,
        };
        try {
          base.collected_info = await leadRepository.getCollectedInfoSummary(l.id, 120);
        } catch {
          base.collected_info = '';
        }
        return base;
      })
    );
    res.json({ leads: leadsWithSummary, total });
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
    const { channel, name, external_id } = parsed.data;
    const displayValue = (name ?? external_id ?? '').trim();
    const lead = await leadRepository.create(req.tenantId, {
      channel,
      name: displayValue || undefined,
      external_id: displayValue || external_id || undefined,
    });
    const out = {
      id: lead.id,
      channel: lead.channel,
      name: lead.name ?? lead.external_id ?? null,
      status_id: lead.status_id ?? null,
      status_name: lead.status_name ?? lead.status ?? null,
      created_at: lead.created_at,
      updated_at: lead.updated_at,
    };
    res.status(201).json(out);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: { code: 'CONFLICT', message: 'Lead already exists for this channel/external_id' } });
    }
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

function toLeadPublic(lead) {
  const nameVal = lead.name ?? lead.external_id ?? null;
  return {
    id: lead.id,
    channel: lead.channel,
    name: nameVal,
    status_id: lead.status_id ?? null,
    status_name: lead.status_name ?? lead.status ?? null,
    created_at: lead.created_at,
    updated_at: lead.updated_at,
  };
}

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

router.get('/:leadId', async (req, res) => {
  try {
    const lead = await leadRepository.findById(req.tenantId, req.params.leadId);
    if (!lead) {
      return errorJson(res, 404, 'NOT_FOUND', 'Lead not found');
    }
    const conversation = await conversationRepository.getByLeadId(req.params.leadId);
    const snapshot = conversation?.quote_snapshot ?? null;
    const orderedSnapshot = Array.isArray(snapshot) ? snapshot : (snapshot?.fields ? snapshot.fields : []);
    const parsedFields = conversation?.parsed_fields ?? {};
    const collectedFromParsed = parsedFieldsToCollected(parsedFields, orderedSnapshot);
    const { required_infos, collected_infos } = computeFieldsState(orderedSnapshot, collectedFromParsed);
    const collectedInfos = (collected_infos ?? []).map((c) => ({
      name: c.name,
      type: c.type ?? 'text',
      value: c.value,
      units: c.units ?? null,
    }));
    res.json({
      id: lead.id,
      channel: lead.channel,
      name: lead.name ?? lead.external_id ?? null,
      status_id: lead.status_id ?? null,
      status_name: lead.status_name ?? lead.status ?? null,
      created_at: lead.created_at,
      updated_at: lead.updated_at,
      collected_infos: collectedInfos,
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.get('/:leadId/conversation', async (req, res) => {
  const requestId = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const leadId = req.params.leadId;
    const companyId = req.tenantId;
    const lead = await leadRepository.findById(companyId, leadId);
    if (!lead) {
      return res.status(404).json({ error: 'not_found', message: 'Lead not found' });
    }
    let conversation = await conversationRepository.getByLeadId(leadId);
    let orderedQuoteFields = [];
    let lookingFor = [];
    let collected = [];
    if (conversation) {
      orderedQuoteFields = (conversation.quote_snapshot ?? [])
        .filter((f) => f && ['text', 'number'].includes(f.type))
        .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
      const collectedFromParsed = parsedFieldsToCollected(conversation.parsed_fields ?? {}, orderedQuoteFields);
      const { required_infos: missingRequired, collected_infos: collectedInfos } = computeFieldsState(orderedQuoteFields, collectedFromParsed);
      lookingFor = (missingRequired ?? []).map((f) => ({
        name: f.name ?? '',
        type: f.type ?? 'text',
        units: f.units ?? null,
        priority: f.priority ?? 100,
        required: true,
      }));
      collected = (collectedInfos ?? []).map((c) => ({
        name: c.name,
        type: c.type ?? 'text',
        value: c.value,
        units: c.units ?? null,
      }));
    } else {
      const fields = await chatbotQuoteFieldsRepository.list(companyId);
      orderedQuoteFields = (fields ?? []).filter((f) => ['text', 'number'].includes(f.type)).sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
      lookingFor = orderedQuoteFields
        .filter((f) => f?.required !== false)
        .map((f) => ({ name: f.name ?? '', type: f.type ?? 'text', units: f.units ?? null, priority: f.priority ?? 100, required: true }));
    }
    res.json({
      lead_id: leadId,
      conversation_id: conversation?.id ?? null,
      messages: conversation?.messages ?? [],
      looking_for: Array.isArray(lookingFor) ? lookingFor : [],
      collected: Array.isArray(collected) ? collected : [],
    });
  } catch (err) {
    console.error('[conversation] GET error', requestId, err.stack);
    res.status(500).json({
      error: 'internal_error',
      message: 'Conversation failed',
      request_id: requestId,
    });
  }
});

router.post('/:leadId/ai-reply', async (req, res) => {
  const requestId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const leadId = req.params.leadId;
    const companyId = req.tenantId;
    const lead = await leadRepository.findById(companyId, leadId);
    if (!lead) {
      return res.status(404).json({ error: 'not_found', message: 'Lead not found' });
    }
    const result = await aiReplyService.generateAiReply(companyId, leadId);

    await conversationRepository.appendMessage(leadId, 'assistant', result.assistant_message);
    await leadRepository.touchUpdatedAt(companyId, leadId);

    let conversation = await conversationRepository.getByLeadId(leadId);
    const merged = result.parsed_fields ?? result.field_updates ?? {};
    const currentParsed = conversation?.parsed_fields ?? {};
    const hasChanges = JSON.stringify(merged) !== JSON.stringify(currentParsed);
    if (hasChanges && Object.keys(merged).length > 0) {
      await conversationRepository.updateParsedFields(leadId, merged);
    }

    conversation = await conversationRepository.getByLeadId(leadId);
    const missingRequired = result.missing_required_infos ?? [];
    const collected = result.collected_infos ?? [];
    const lookingFor = missingRequired.map((f) => ({
      name: f.name ?? '',
      type: f.type ?? 'text',
      units: f.units ?? null,
      priority: f.priority ?? 100,
      required: true,
    }));
    const collectedOut = collected.map((c) => ({
      name: c.name,
      type: c.type ?? 'text',
      value: c.value,
      units: c.units ?? null,
    }));
    res.json({
      assistant_message: result.assistant_message,
      conversation_id: result.conversation_id ?? conversation?.id,
      lead_id: leadId,
      looking_for: Array.isArray(lookingFor) ? lookingFor : [],
      collected: Array.isArray(collectedOut) ? collectedOut : [],
      messages: conversation?.messages ?? [],
    });
  } catch (err) {
    console.error('[conversation] POST ai-reply error', requestId, err.stack);
    res.status(500).json({
      error: 'internal_error',
      message: 'Conversation failed',
      request_id: requestId,
    });
  }
});

router.post('/:leadId/messages', async (req, res) => {
  const requestId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const leadId = req.params.leadId;
    const companyId = req.tenantId;
    const { role, content } = req.body;
    const lead = await leadRepository.findById(companyId, leadId);
    if (!lead) {
      return res.status(404).json({ error: 'not_found', message: 'Lead not found' });
    }
    if (!role || !content) {
      return res.status(400).json({ error: 'validation_error', message: 'role and content are required' });
    }
    let conversation = await conversationRepository.getByLeadId(leadId);
    if (!conversation) {
      conversation = await conversationRepository.createIfNotExists(leadId, companyId);
    }
    await conversationRepository.appendMessage(leadId, role, content);
    await leadRepository.touchUpdatedAt(companyId, leadId);

    if (role === 'user') {
      conversation = await conversationRepository.getByLeadId(leadId);
      return res.json({
        ok: true,
        lead_id: leadId,
        conversation_id: conversation?.id ?? null,
        messages: conversation?.messages ?? [],
      });
    }

    conversation = await conversationRepository.getByLeadId(leadId);
    const orderedQuoteFields = (conversation?.quote_snapshot ?? [])
      .filter((f) => f && ['text', 'number'].includes(f.type))
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    const collectedFromParsed = parsedFieldsToCollected(conversation?.parsed_fields ?? {}, orderedQuoteFields);
    const { required_infos: missingRequired, collected_infos: collectedInfos } = computeFieldsState(orderedQuoteFields, collectedFromParsed);
    const lookingFor = (missingRequired ?? []).map((f) => ({ name: f.name ?? '', type: f.type ?? 'text', units: f.units ?? null, priority: f.priority ?? 100, required: true }));
    const collected = (collectedInfos ?? []).map((c) => ({ name: c.name, type: c.type ?? 'text', value: c.value, units: c.units ?? null }));

    res.json({
      lead_id: leadId,
      conversation_id: conversation?.id ?? null,
      messages: conversation?.messages ?? [],
      looking_for: Array.isArray(lookingFor) ? lookingFor : [],
      collected: Array.isArray(collected) ? collected : [],
    });
  } catch (err) {
    console.error('[conversation] POST messages error', requestId, err.stack);
    res.status(500).json({
      error: 'internal_error',
      message: 'Conversation failed',
      request_id: requestId,
    });
  }
});

router.patch('/:leadId/status', async (req, res) => {
  try {
    const parsed = patchStatusBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.flatten().formErrors?.join?.(' ') || 'status_id (uuid) is required';
      return res.status(400).json({ error: msg });
    }
    const lead = await leadRepository.setStatus(req.tenantId, req.params.leadId, parsed.data.status_id);
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found or status invalid for company' });
    }
    res.json(lead);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.patch('/:leadId/name', async (req, res) => {
  try {
    const parsed = patchNameBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.flatten().formErrors?.join?.(' ') || 'Invalid name';
      return res.status(400).json({ error: msg });
    }
    const lead = await leadRepository.setName(req.tenantId, req.params.leadId, parsed.data.name);
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    res.json(lead);
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
    if (parsed.data.status_id !== undefined) updateData.status_id = parsed.data.status_id;
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
