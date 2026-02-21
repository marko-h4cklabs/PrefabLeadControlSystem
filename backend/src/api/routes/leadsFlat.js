const express = require('express');
const multer = require('multer');
const router = express.Router();
const {
  leadRepository,
  companyLeadStatusesRepository,
  conversationRepository,
  chatAttachmentRepository,
  notificationRepository,
} = require('../../../db/repositories');

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
const { errorJson } = require('../middleware/errors');
const { computeFieldsState } = require('../../chat/fieldsState');
const { appendPictureToParsed, picturesToCollected, attachmentsToPicturesCollected } = require('../../chat/picturesHelpers');
const {
  listLeadsQuerySchema,
  createLeadBodySchema,
  updateLeadBodySchema,
  patchNameBodySchema,
  patchStatusBodySchema,
} = require('../validators/leadSchemas');

function toLeadResponse(lead) {
  const nameVal = lead.name ?? lead.external_id ?? null;
  return {
    id: lead.id,
    channel: lead.channel,
    name: nameVal,
    status_id: lead.status_id ?? null,
    status_name: lead.status_name ?? lead.status ?? null,
    created_at: lead.created_at,
    updated_at: lead.updated_at,
    source: lead.source ?? 'inbox',
  };
}

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

router.get('/statuses', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const rows = await companyLeadStatusesRepository.list(req.tenantId);
    const statuses = (Array.isArray(rows) ? rows : []).map((s) => ({
      id: s.id,
      name: s.name,
      position: s.position ?? s.sort_order ?? 0,
    }));
    res.json({ statuses });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

router.get('/', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const parsed = listLeadsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const err = parsed.error.flatten();
      if (process.env.NODE_ENV !== 'production') {
        console.info('[leads] rejected query params:', req.query, 'errors:', err.fieldErrors);
      }
      const msg = err.formErrors?.join?.(' ') || 'Invalid query parameters';
      return res.status(400).json({ error: msg });
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
      (Array.isArray(leads) ? leads : []).map(async (lead) => {
        const base = toLeadResponse(lead);
        const out = {
          id: base.id,
          channel: base.channel,
          name: base.name ?? base.external_id ?? null,
          status_id: base.status_id,
          status_name: base.status_name,
          created_at: base.created_at,
          updated_at: base.updated_at,
          source: base.source ?? 'inbox',
        };
        try {
          out.collected_info = await leadRepository.getCollectedInfoSummary(lead.id, 120);
        } catch {
          out.collected_info = '';
        }
        return out;
      })
    );
    res.json({
      leads: leadsWithSummary,
      total: typeof total === 'number' ? total : 0,
    });
  } catch (err) {
    console.error('[leads] list error:', err.message);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

function parsedFieldsToCollected(parsedFields, quoteFields) {
  const quoteByName = Object.fromEntries((quoteFields ?? []).map((f) => [f.name, f]));
  return Object.entries(parsedFields ?? {})
    .filter(([, v]) => {
      if (v == null) return false;
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

router.get('/:id', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const lead = await leadRepository.findById(req.tenantId, req.params.id);
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    const conversation = await conversationRepository.getByLeadId(req.params.id);
    const snapshot = conversation?.quote_snapshot ?? null;
    const orderedSnapshot = Array.isArray(snapshot) ? snapshot : (snapshot?.fields ? snapshot.fields : []);
    const parsedFields = conversation?.parsed_fields ?? {};
    let collectedFromParsed = parsedFieldsToCollected(parsedFields, orderedSnapshot);
    const picturesPreset = (orderedSnapshot ?? []).find((f) => f?.name === 'pictures' && f?.is_enabled !== false);
    if (picturesPreset) {
      const hasPictures = collectedFromParsed.some((c) => c.name === 'pictures');
      if (!hasPictures) {
        const attachments = await chatAttachmentRepository.getByLeadId(req.tenantId, req.params.id);
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
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

router.post('/:id/attachments', upload.single('file'), async (req, res) => {
  try {
    const leadId = req.params.id;
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
    res.status(500).json({ error: err.message || 'Internal server error' });
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
    const leadSource = lead.source ?? source ?? 'inbox';
    if (leadSource === 'inbox') {
      const leadName = lead.name ?? lead.external_id ?? 'Unknown';
      const body = `${leadName} (${lead.channel})`;
      await notificationRepository.create(req.tenantId, {
        leadId: lead.id,
        type: 'new_lead',
        title: 'New inquiry',
        body,
        url: `/inbox/${lead.id}`,
      }).catch(() => {});
    }
    res.status(201).json(toLeadResponse(lead));
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: { code: 'CONFLICT', message: 'Lead already exists for this channel/external_id' },
      });
    }
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.patch('/:id/status', async (req, res) => {
  try {
    const parsed = patchStatusBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.flatten().formErrors?.join?.(' ') || 'status_id (uuid) is required';
      return res.status(400).json({ error: msg });
    }
    const lead = await leadRepository.setStatus(req.tenantId, req.params.id, parsed.data.status_id);
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found or status invalid for company' });
    }
    res.json(toLeadResponse(lead));
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.patch('/:id/name', async (req, res) => {
  try {
    const parsed = patchNameBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.flatten().formErrors?.join?.(' ') || 'Invalid name';
      return res.status(400).json({ error: msg });
    }
    const lead = await leadRepository.setName(req.tenantId, req.params.id, parsed.data.name);
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    res.json(toLeadResponse(lead));
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.patch('/:id', async (req, res) => {
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
    const lead = await leadRepository.update(req.tenantId, req.params.id, updateData);
    if (!lead) {
      return errorJson(res, 404, 'NOT_FOUND', 'Lead not found');
    }
    res.json(toLeadResponse(lead));
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

module.exports = router;
