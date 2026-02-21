const express = require('express');
const multer = require('multer');
const router = express.Router();
const {
  leadRepository,
  companyLeadStatusesRepository,
  conversationRepository,
  chatAttachmentRepository,
  leadActivitiesRepository,
  leadNotesRepository,
  leadTasksRepository,
} = require('../../../db/repositories');
const { notifyNewLeadCreated } = require('../../../services/newLeadNotifier');
const { logLeadActivity } = require('../../../services/activityLogger');

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
const {
  crmActivityQuerySchema,
  crmNotesQuerySchema,
  crmTasksQuerySchema,
  createNoteBodySchema,
  updateNoteBodySchema,
  createTaskBodySchema,
  updateTaskBodySchema,
} = require('../validators/crmSchemas');

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

// --- CRM routes: use :leadId for consistency with frontend /api/leads/:leadId/activity etc. ---
const crmLeadRouter = require('./crm');
router.use('/:leadId/crm', crmLeadRouter);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function ensureLeadForCrm(req, res, next) {
  const leadId = req.params.leadId;
  if (!leadId || !UUID_REGEX.test(String(leadId))) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[crm] invalid leadId:', { leadId, params: req.params });
    }
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Valid lead ID (UUID) required' } });
  }
  const companyId = req.tenantId;
  if (!companyId) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
  }
  const lead = await leadRepository.findById(companyId, leadId);
  if (!lead) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[crm] lead not found:', { companyId, leadId });
    }
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Lead not found' } });
  }
  req.lead = lead;
  req.crmLeadId = leadId;
  next();
}

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

// --- CRM GET routes: /:leadId/... matches /api/leads/:leadId/activity etc. BEFORE generic GET /:id ---
router.get('/:leadId/activity', ensureLeadForCrm, async (req, res) => {
  try {
    const leadId = req.crmLeadId;
    if (process.env.NODE_ENV !== 'production') {
      console.info('[crm] GET activity', { leadId, tenantId: req.tenantId });
    }
    const parsed = crmActivityQuerySchema.safeParse(req.query);
    const { limit, offset } = parsed.success ? parsed.data : { limit: 50, offset: 0 };
    const items = await leadActivitiesRepository.listByLead(req.tenantId, leadId, { limit, offset });
    const total = await leadActivitiesRepository.countByLead(req.tenantId, leadId);
    res.json({ items: Array.isArray(items) ? items.map(toCrmActivityItem) : [], total: typeof total === 'number' ? total : 0 });
  } catch (err) {
    if (err.code === '42P01') return res.json({ items: [], total: 0 });
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});
router.get('/:leadId/notes', ensureLeadForCrm, async (req, res) => {
  try {
    const leadId = req.crmLeadId;
    if (process.env.NODE_ENV !== 'production') {
      console.info('[crm] GET notes', { leadId, tenantId: req.tenantId });
    }
    const parsed = crmNotesQuerySchema.safeParse(req.query);
    const { limit, offset } = parsed.success ? parsed.data : { limit: 50, offset: 0 };
    const items = await leadNotesRepository.listByLead(req.tenantId, leadId, { limit, offset });
    const total = await leadNotesRepository.countByLead(req.tenantId, leadId);
    res.json({ items: Array.isArray(items) ? items.map(toCrmNoteItem) : [], total: typeof total === 'number' ? total : 0 });
  } catch (err) {
    if (err.code === '42P01') return res.json({ items: [], total: 0 });
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});
router.get('/:leadId/tasks', ensureLeadForCrm, async (req, res) => {
  try {
    const leadId = req.crmLeadId;
    if (process.env.NODE_ENV !== 'production') {
      console.info('[crm] GET tasks', { leadId, tenantId: req.tenantId });
    }
    const parsed = crmTasksQuerySchema.safeParse(req.query);
    const { limit, offset, status } = parsed.success ? parsed.data : { limit: 50, offset: 0, status: undefined };
    const items = await leadTasksRepository.listByLead(req.tenantId, leadId, { limit, offset, status });
    const total = await leadTasksRepository.countByLead(req.tenantId, leadId, status ? { status } : {});
    res.json({ items: Array.isArray(items) ? items.map(toCrmTaskItem) : [], total: typeof total === 'number' ? total : 0 });
  } catch (err) {
    if (err.code === '42P01') return res.json({ items: [], total: 0 });
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

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
    const existing = await leadRepository.findById(req.tenantId, req.params.id);
    const lead = await leadRepository.setStatus(req.tenantId, req.params.id, parsed.data.status_id);
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

// --- CRM POST/PATCH/DELETE (notes, tasks) ---
function toCrmActivityItem(row) {
  return {
    id: row.id,
    event_type: row.event_type,
    actor_type: row.actor_type,
    actor_user_id: row.actor_user_id,
    source: row.source,
    channel: row.channel,
    metadata: row.metadata ?? {},
    created_at: row.created_at,
  };
}
function toCrmNoteItem(note) {
  return { id: note.id, body: note.body, created_by_user_id: note.created_by_user_id, updated_by_user_id: note.updated_by_user_id, created_at: note.created_at, updated_at: note.updated_at };
}
function toCrmTaskItem(task) {
  return { id: task.id, title: task.title, description: task.description, status: task.status, due_at: task.due_at, assigned_user_id: task.assigned_user_id, created_by_user_id: task.created_by_user_id, completed_at: task.completed_at, created_at: task.created_at, updated_at: task.updated_at };
}

router.post('/:leadId/notes', ensureLeadForCrm, async (req, res) => {
  try {
    const leadId = req.crmLeadId;
    const parsed = createNoteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const err = parsed.error.flatten();
      const msg = err.formErrors?.[0] ?? Object.values(err.fieldErrors ?? {})?.flat?.()?.[0] ?? 'Validation failed';
      if (process.env.NODE_ENV !== 'production') {
        console.debug('[notes create] validation failed', { leadId, bodyKeys: Object.keys(req.body || {}) });
      }
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: msg, details: err.fieldErrors } });
    }
    const note = await leadNotesRepository.create({ companyId: req.tenantId, leadId, body: parsed.data.body, createdByUserId: req.user?.id });
    logLeadActivity({ companyId: req.tenantId, leadId, eventType: 'note_created', actorType: 'user', actorUserId: req.user?.id, metadata: {} }).catch(() => {});
    res.status(201).json(toCrmNoteItem(note));
  } catch (err) {
    if (err.code === '42P01') return res.status(500).json({ error: { code: 'CRM_TABLES_MISSING', message: 'CRM tables not yet migrated' } });
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.patch('/:leadId/notes/:noteId', ensureLeadForCrm, async (req, res) => {
  try {
    const leadId = req.crmLeadId;
    const parsed = updateNoteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const err = parsed.error.flatten();
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: err.formErrors?.join?.(' ') || 'Validation failed', details: err.fieldErrors } });
    }
    const note = await leadNotesRepository.update({ companyId: req.tenantId, leadId, noteId: req.params.noteId, body: parsed.data.body, updatedByUserId: req.user?.id });
    if (!note) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Note not found' } });
    logLeadActivity({ companyId: req.tenantId, leadId, eventType: 'note_updated', actorType: 'user', actorUserId: req.user?.id, metadata: {} }).catch(() => {});
    res.json(toCrmNoteItem(note));
  } catch (err) {
    if (err.code === '42P01') return res.status(500).json({ error: { code: 'CRM_TABLES_MISSING', message: 'CRM tables not yet migrated' } });
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.delete('/:leadId/notes/:noteId', ensureLeadForCrm, async (req, res) => {
  try {
    const leadId = req.crmLeadId;
    const removed = await leadNotesRepository.remove({ companyId: req.tenantId, leadId, noteId: req.params.noteId });
    if (!removed) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Note not found' } });
    logLeadActivity({ companyId: req.tenantId, leadId, eventType: 'note_deleted', actorType: 'user', actorUserId: req.user?.id, metadata: {} }).catch(() => {});
    res.status(204).send();
  } catch (err) {
    if (err.code === '42P01') return res.status(500).json({ error: { code: 'CRM_TABLES_MISSING', message: 'CRM tables not yet migrated' } });
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.post('/:leadId/tasks', ensureLeadForCrm, async (req, res) => {
  try {
    const leadId = req.crmLeadId;
    const parsed = createTaskBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const err = parsed.error.flatten();
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: err.formErrors?.join?.(' ') || 'Validation failed', details: err.fieldErrors } });
    }
    const { title, description, due_at, assigned_user_id } = parsed.data;
    const task = await leadTasksRepository.create({ companyId: req.tenantId, leadId, title, description: description ?? null, dueAt: due_at ?? null, assignedUserId: assigned_user_id ?? null, createdByUserId: req.user?.id });
    logLeadActivity({ companyId: req.tenantId, leadId, eventType: 'task_created', actorType: 'user', actorUserId: req.user?.id, metadata: {} }).catch(() => {});
    res.status(201).json(toCrmTaskItem(task));
  } catch (err) {
    if (err.code === '42P01') return res.status(500).json({ error: { code: 'CRM_TABLES_MISSING', message: 'CRM tables not yet migrated' } });
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.patch('/:leadId/tasks/:taskId', ensureLeadForCrm, async (req, res) => {
  try {
    const leadId = req.crmLeadId;
    const parsed = updateTaskBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const err = parsed.error.flatten();
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: err.formErrors?.join?.(' ') || 'Validation failed', details: err.fieldErrors } });
    }
    const patch = {};
    if (parsed.data.title !== undefined) patch.title = parsed.data.title;
    if (parsed.data.description !== undefined) patch.description = parsed.data.description;
    if (parsed.data.status !== undefined) patch.status = parsed.data.status;
    if (parsed.data.due_at !== undefined) patch.due_at = parsed.data.due_at;
    if (parsed.data.assigned_user_id !== undefined) patch.assigned_user_id = parsed.data.assigned_user_id;
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'At least one field to update is required' } });
    const prevTask = await leadTasksRepository.findById(req.tenantId, leadId, req.params.taskId);
    const task = await leadTasksRepository.update({ companyId: req.tenantId, leadId, taskId: req.params.taskId, patch });
    if (!task) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Task not found' } });
    const wasNotDone = prevTask && prevTask.status !== 'done';
    if (patch.status === 'done' && wasNotDone) {
      logLeadActivity({ companyId: req.tenantId, leadId, eventType: 'task_completed', actorType: 'user', actorUserId: req.user?.id, metadata: {} }).catch(() => {});
    } else {
      logLeadActivity({ companyId: req.tenantId, leadId, eventType: 'task_updated', actorType: 'user', actorUserId: req.user?.id, metadata: {} }).catch(() => {});
    }
    res.json(toCrmTaskItem(task));
  } catch (err) {
    if (err.code === '42P01') return res.status(500).json({ error: { code: 'CRM_TABLES_MISSING', message: 'CRM tables not yet migrated' } });
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.delete('/:leadId/tasks/:taskId', ensureLeadForCrm, async (req, res) => {
  try {
    const leadId = req.crmLeadId;
    const removed = await leadTasksRepository.remove({ companyId: req.tenantId, leadId, taskId: req.params.taskId });
    if (!removed) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Task not found' } });
    logLeadActivity({ companyId: req.tenantId, leadId, eventType: 'task_deleted', actorType: 'user', actorUserId: req.user?.id, metadata: {} }).catch(() => {});
    res.status(204).send();
  } catch (err) {
    if (err.code === '42P01') return res.status(500).json({ error: { code: 'CRM_TABLES_MISSING', message: 'CRM tables not yet migrated' } });
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ---- Lead Appointments ----
const { createAppointmentHandler } = require('./appointments');
const { appointmentRepository } = require('../../../db/repositories');
const { listAppointmentsSchema } = require('../validators/appointmentSchemas');

router.get('/:leadId/appointments', ensureLeadForCrm, async (req, res) => {
  try {
    const parsed = listAppointmentsSchema.safeParse(req.query);
    if (!parsed.success) {
      const flat = parsed.error.flatten();
      const fieldMsgs = Object.entries(flat.fieldErrors ?? {})
        .map(([f, msgs]) => `${f}: ${(msgs || []).join(', ')}`)
        .filter(Boolean);
      const msg = flat.formErrors?.[0] || fieldMsgs.join('; ') || 'Validation failed';
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: msg } });
    }

    const { from, to, status, appointment_type, limit, offset } = parsed.data;
    const companyId = req.tenantId;
    const leadId = req.crmLeadId;
    const opts = { from, to, status, appointmentType: appointment_type, leadId, limit, offset };

    const [items, total] = await Promise.all([
      appointmentRepository.list(companyId, opts),
      appointmentRepository.count(companyId, opts),
    ]);

    res.json({ items, total, range: { from: from ?? null, to: to ?? null } });
  } catch (err) {
    console.error('[leads/:leadId/appointments] list error:', err.message);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to list lead appointments');
  }
});

router.post('/:leadId/appointments', ensureLeadForCrm, (req, res) => {
  return createAppointmentHandler(req, res, req.crmLeadId);
});

module.exports = router;
