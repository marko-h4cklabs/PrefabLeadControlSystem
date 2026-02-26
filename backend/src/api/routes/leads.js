const express = require('express');
const multer = require('multer');
const router = express.Router({ mergeParams: true });

const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ATTACHMENT_MAX_BYTES },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('Only images allowed'));
    }
    cb(null, true);
  },
});

const {
  leadRepository,
  conversationRepository,
  chatbotBehaviorRepository,
  chatbotQuoteFieldsRepository,
  companyLeadStatusesRepository,
  chatAttachmentRepository,
  notificationRepository,
} = require('../../../db/repositories');
const { notifyNewLeadCreated } = require('../../../services/newLeadNotifier');
const { logLeadActivity } = require('../../../services/activityLogger');
const aiReplyService = require('../../../services/aiReplyService');
const { computeFieldsState } = require('../../chat/fieldsState');
const { appendPictureToParsed, picturesToCollected, attachmentsToPicturesCollected } = require('../../chat/picturesHelpers');
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
    const { limit, offset, status, statusId, status_id, query, source } = parsed.data;
    let filterStatusId = statusId || status_id;
    if (filterStatusId === 'all' || filterStatusId === '__ALL__') {
      filterStatusId = null;
    }
    const filterSource = source ?? 'inbox';
    const leads = await leadRepository.findAll(req.tenantId, {
      status,
      status_id: filterStatusId,
      query,
      source: filterSource,
      limit,
      offset,
    });
    const total = await leadRepository.count(req.tenantId, { status, status_id: filterStatusId, query, source: filterSource });
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
          source: l.source ?? 'inbox',
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
    const { channel, name, external_id, source } = parsed.data;
    const normalizedName = (name ?? '').trim();
    const lead = await leadRepository.create(req.tenantId, {
      channel,
      name: normalizedName || undefined,
      external_id: external_id ?? (normalizedName || undefined),
      source: source ?? 'inbox',
    });
    notifyNewLeadCreated(req.tenantId, lead, { userEmail: req.user?.email }).catch(() => {});
    logLeadActivity({
      companyId: req.tenantId,
      leadId: lead.id,
      eventType: 'lead_created',
      actorType: 'user',
      actorUserId: req.user?.id,
      source: lead.source ?? 'inbox',
      channel: lead.channel,
      metadata: {},
    }).catch(() => {});
    const out = {
      id: lead.id,
      channel: lead.channel,
      name: lead.name ?? lead.external_id ?? null,
      status_id: lead.status_id ?? null,
      status_name: lead.status_name ?? lead.status ?? null,
      created_at: lead.created_at,
      updated_at: lead.updated_at,
      source: lead.source ?? 'inbox',
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
    .filter(([key, v]) => {
      if (key.startsWith('__')) return false;
      if (v == null) return false;
      if (typeof v === 'object' && !Array.isArray(v)) return false;
      if (Array.isArray(v)) return v.length > 0;
      return String(v).trim() !== '';
    })
    .map(([name, value]) => {
      const qf = quoteByName[name];
      const type = name === 'pictures' ? 'pictures' : (qf?.type ?? 'text');
      const base = { name, type, units: qf?.units ?? null, priority: qf?.priority ?? 100 };
      if (name === 'pictures') {
        const { value: urls, links } = picturesToCollected(value);
        return { ...base, value: urls, links };
      }
      return { ...base, value };
    });
}

// CRM routes: /api/companies/:companyId/leads/:leadId/crm/activity, /crm/notes, /crm/tasks
const crmLeadRouter = require('./crm');
router.use('/:leadId/crm', crmLeadRouter);

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
    let collectedFromParsed = parsedFieldsToCollected(parsedFields, orderedSnapshot);
    const picturesPreset = (orderedSnapshot ?? []).find((f) => f?.name === 'pictures' && f?.is_enabled !== false);
    if (picturesPreset) {
      const hasPictures = collectedFromParsed.some((c) => c.name === 'pictures');
      if (!hasPictures) {
        const attachments = await chatAttachmentRepository.getByLeadId(req.tenantId, req.params.leadId);
        if (attachments.length > 0) {
          const baseUrl = process.env.BACKEND_URL || `${req.protocol}://${req.get('host') || 'localhost:3000'}`;
          const { value: urls, links } = attachmentsToPicturesCollected(attachments, baseUrl);
          collectedFromParsed = [...collectedFromParsed, { name: 'pictures', value: urls, links, type: 'pictures', units: null, priority: picturesPreset.priority ?? 100 }];
        }
      }
    }
    const { required_infos, collected_infos } = computeFieldsState(orderedSnapshot, collectedFromParsed);
    const collectedInfos = (collected_infos ?? []).map((c) => ({
      name: c.name,
      type: c.type ?? 'text',
      value: c.value,
      units: c.units ?? null,
      ...(c.links && { links: c.links }),
    }));
    res.json({
      id: lead.id,
      channel: lead.channel,
      name: lead.name ?? lead.external_id ?? null,
      status_id: lead.status_id ?? null,
      status_name: lead.status_name ?? lead.status ?? null,
      created_at: lead.created_at,
      updated_at: lead.updated_at,
      source: lead.source ?? 'inbox',
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
    const validTypes = ['text', 'number', 'select_multi', 'composite_dimensions', 'boolean', 'pictures'];
    if (conversation) {
      orderedQuoteFields = (conversation.quote_snapshot ?? [])
        .filter((f) => f && validTypes.includes(f.type))
        .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
      let collectedFromParsed = parsedFieldsToCollected(conversation.parsed_fields ?? {}, orderedQuoteFields);
      const picturesPreset = (orderedQuoteFields ?? []).find((f) => f?.name === 'pictures' && f?.is_enabled !== false);
      if (picturesPreset) {
        const hasPictures = collectedFromParsed.some((c) => c.name === 'pictures');
        if (!hasPictures) {
          const attachments = await chatAttachmentRepository.getByLeadId(companyId, leadId);
          if (attachments.length > 0) {
            const baseUrl = process.env.BACKEND_URL || `${req.protocol}://${req.get('host') || 'localhost:3000'}`;
            const { value: urls, links } = attachmentsToPicturesCollected(attachments, baseUrl);
            collectedFromParsed = [...collectedFromParsed, { name: 'pictures', value: urls, links, type: 'pictures', units: null, priority: picturesPreset.priority ?? 100 }];
          }
        }
      }
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
        ...(c.links && { links: c.links }),
      }));
    } else {
      const fields = await chatbotQuoteFieldsRepository.list(companyId);
      const enabled = chatbotQuoteFieldsRepository.getEnabledFields(fields ?? []);
      orderedQuoteFields = (enabled ?? []).filter((f) => validTypes.includes(f.type)).sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
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

router.post('/:leadId/attachments', upload.single('file'), async (req, res) => {
  try {
    const leadId = req.params.leadId;
    const companyId = req.tenantId;
    const lead = await leadRepository.findById(companyId, leadId);
    if (!lead) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Lead not found' } });
    }
    const file = req.file;
    if (!file || !file.buffer) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'file field required' } });
    }
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Only images allowed' } });
    }
    if (file.size > ATTACHMENT_MAX_BYTES) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'File too large (max 5MB)' } });
    }
    const conversation = await conversationRepository.getByLeadId(leadId);
    const attachment = await chatAttachmentRepository.create(companyId, leadId, {
      mimeType: file.mimetype,
      fileName: file.originalname || null,
      byteSize: file.size,
      buffer: file.buffer,
      conversationId: conversation?.id ?? null,
    });
    const baseUrl = process.env.BACKEND_URL || `${req.protocol}://${req.get('host') || 'localhost:3000'}`;
    const url = `${baseUrl.replace(/\/+$/, '')}/public/attachments/${attachment.id}/${attachment.public_token}`;

    let conv = conversation;
    if (!conv) {
      conv = await conversationRepository.createIfNotExists(leadId, companyId);
    }
    const parsed = conv?.parsed_fields ?? {};
    const pictures = appendPictureToParsed(parsed.pictures, url);
    await conversationRepository.updateParsedFields(leadId, { ...parsed, pictures });

    res.status(201).json({
      attachment_id: attachment.id,
      url,
      mime_type: attachment.mime_type,
      file_name: attachment.file_name || null,
    });
  } catch (err) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'File too large (max 5MB)' } });
    }
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
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
    logLeadActivity({
      companyId,
      leadId,
      eventType: 'ai_reply_sent',
      actorType: 'ai',
      source: lead.source ?? null,
      channel: lead.channel,
      metadata: {},
    }).catch(() => {});

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
      ...(c.links && { links: c.links }),
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
      logLeadActivity({
        companyId,
        leadId,
        eventType: 'message_received',
        actorType: 'user',
        actorUserId: req.user?.id,
        source: lead.source ?? null,
        channel: lead.channel,
        metadata: {},
      }).catch(() => {});
    }

    if (role === 'user' && (lead.source ?? 'inbox') === 'inbox') {
      const leadName = lead.name ?? lead.external_id ?? 'Unknown';
      const snippet = String(content ?? '').slice(0, 80);
      const body = snippet ? `${leadName}: ${snippet}${snippet.length >= 80 ? '…' : ''}` : leadName;
      await notificationRepository.create(companyId, {
        leadId,
        type: 'new_message',
        title: 'New message',
        body,
        url: `/inbox/${leadId}/conversation`,
      }).catch(() => {});
    }

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
    const validTypes = ['text', 'number', 'select_multi', 'composite_dimensions', 'boolean', 'pictures'];
    const orderedQuoteFields = (conversation?.quote_snapshot ?? [])
      .filter((f) => f && validTypes.includes(f.type))
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    let collectedFromParsed = parsedFieldsToCollected(conversation?.parsed_fields ?? {}, orderedQuoteFields);
    const picturesPreset = (orderedQuoteFields ?? []).find((f) => f?.name === 'pictures' && f?.is_enabled !== false);
    if (picturesPreset) {
      const hasPictures = collectedFromParsed.some((c) => c.name === 'pictures');
      if (!hasPictures) {
        const attachments = await chatAttachmentRepository.getByLeadId(companyId, leadId);
        if (attachments.length > 0) {
          const baseUrl = process.env.BACKEND_URL || `${req.protocol}://${req.get('host') || 'localhost:3000'}`;
          const { value: urls, links } = attachmentsToPicturesCollected(attachments, baseUrl);
          collectedFromParsed = [...collectedFromParsed, { name: 'pictures', value: urls, links, type: 'pictures', units: null, priority: picturesPreset.priority ?? 100 }];
        }
      }
    }
    const { required_infos: missingRequired, collected_infos: collectedInfos } = computeFieldsState(orderedQuoteFields, collectedFromParsed);
    const lookingFor = (missingRequired ?? []).map((f) => ({ name: f.name ?? '', type: f.type ?? 'text', units: f.units ?? null, priority: f.priority ?? 100, required: true }));
    const collected = (collectedInfos ?? []).map((c) => ({
      name: c.name,
      type: c.type ?? 'text',
      value: c.value,
      units: c.units ?? null,
      ...(c.links && { links: c.links }),
    }));

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
    const existing = await leadRepository.findById(req.tenantId, req.params.leadId);
    const lead = await leadRepository.setStatus(req.tenantId, req.params.leadId, parsed.data.status_id);
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found or status invalid for company' });
    }
    logLeadActivity({
      companyId: req.tenantId,
      leadId: lead.id,
      eventType: 'lead_status_changed',
      actorType: 'user',
      actorUserId: req.user?.id,
      source: lead.source ?? null,
      channel: lead.channel,
      metadata: {
        previous_status: existing?.status_name ?? existing?.status_id ?? null,
        new_status: lead.status_name ?? lead.status_id ?? null,
      },
    }).catch(() => {});
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
