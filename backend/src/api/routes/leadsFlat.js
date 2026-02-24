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
  appointmentRepository,
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
const { pool } = require('../../../db');
const leadImportRouter = require('./leadImport');
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
    intent_score: lead.intent_score ?? null,
    budget_detected: lead.budget_detected ?? null,
    is_hot_lead: lead.is_hot_lead ?? false,
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

router.use(leadImportRouter);

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
    const { limit, offset, status, statusId, status_id, query, source, sort, order } = parsed.data;
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
      sort,
      order,
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

// GET /api/leads/search?q=...
router.get('/search', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const q = (req.query.q || '').trim();
    if (!q) {
      return res.json({ leads: [], total: 0 });
    }
    const pattern = '%' + q.replace(/%/g, '\\%').replace(/_/g, '\\_') + '%';
    const r = await pool.query(
      `SELECT l.id, l.name, l.external_id, l.channel, l.status, l.pipeline_stage, l.intent_score, l.budget_detected, l.created_at,
              cls.name AS status_name,
              (SELECT c.messages FROM conversations c WHERE c.lead_id = l.id LIMIT 1) AS messages_json
       FROM leads l
       LEFT JOIN company_lead_statuses cls ON cls.id = l.status_id AND cls.company_id = l.company_id
       WHERE l.company_id = $1
         AND (l.name ILIKE $2 OR l.external_id ILIKE $2 OR (l.budget_detected::text ILIKE $2)
              OR EXISTS (SELECT 1 FROM conversations c WHERE c.lead_id = l.id AND c.messages::text ILIKE $2))
       ORDER BY l.updated_at DESC NULLS LAST, l.created_at DESC
       LIMIT 50`,
      [companyId, pattern]
    );
    const leads = (r.rows || []).map((row) => {
      let snippet = null;
      if (row.messages_json && Array.isArray(row.messages_json)) {
        const texts = row.messages_json.map((m) => (m && m.content) || '').filter(Boolean);
        snippet = texts.join(' ').slice(0, 120) + (texts.join(' ').length > 120 ? '...' : '');
      }
      return {
        id: row.id,
        name: row.name ?? row.external_id ?? null,
        external_id: row.external_id,
        channel: row.channel,
        status: row.status,
        status_name: row.status_name,
        pipeline_stage: row.pipeline_stage,
        intent_score: row.intent_score,
        budget_detected: row.budget_detected,
        created_at: row.created_at,
        snippet,
      };
    });
    res.json({ leads, total: leads.length });
  } catch (err) {
    console.error('[leads] search:', err.message);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// GET /api/leads/filter?status=&pipeline_stage=&is_hot_lead=&has_budget=&intent_score_min=&channel=&assigned_to=&from=&to=
router.get('/filter', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const {
      status,
      pipeline_stage,
      is_hot_lead,
      has_budget,
      intent_score_min,
      channel,
      assigned_to,
      from,
      to,
    } = req.query;
    let sql = `SELECT l.*, cls.name AS status_name
               FROM leads l
               LEFT JOIN company_lead_statuses cls ON cls.id = l.status_id AND cls.company_id = l.company_id
               WHERE l.company_id = $1`;
    const params = [companyId];
    let idx = 2;
    if (status) {
      sql += ` AND l.status = $${idx++}`;
      params.push(status);
    }
    if (pipeline_stage) {
      sql += ` AND l.pipeline_stage = $${idx++}`;
      params.push(pipeline_stage);
    }
    if (is_hot_lead === 'true' || is_hot_lead === true) {
      sql += ` AND l.is_hot_lead = true`;
    }
    if (has_budget === 'true' || has_budget === true) {
      sql += ` AND l.budget_detected IS NOT NULL AND l.budget_detected::text <> ''`;
    }
    if (intent_score_min != null && intent_score_min !== '') {
      sql += ` AND l.intent_score >= $${idx++}`;
      params.push(parseInt(intent_score_min, 10));
    }
    if (channel) {
      sql += ` AND l.channel = $${idx++}`;
      params.push(channel);
    }
    if (assigned_to) {
      sql += ` AND l.assigned_setter_id = $${idx++}`;
      params.push(assigned_to);
    }
    if (from) {
      sql += ` AND l.created_at >= $${idx++}::timestamptz`;
      params.push(from);
    }
    if (to) {
      sql += ` AND l.created_at <= $${idx++}::timestamptz`;
      params.push(to);
    }
    sql += ` ORDER BY l.updated_at DESC NULLS LAST, l.created_at DESC LIMIT 200`;
    const r = await pool.query(sql, params);
    const leads = (r.rows || []).map((row) => toLeadResponse({ ...row, status_name: row.status_name }));
    res.json({ leads });
  } catch (err) {
    console.error('[leads] filter:', err.message);
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

router.get('/:leadId/intelligence', async (req, res) => {
  try {
    const leadId = req.params.leadId;
    const companyId = req.tenantId;
    const lead = await leadRepository.findById(companyId, leadId);
    if (!lead) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Lead not found' } });
    }
    const row = await pool.query(
      `SELECT intent_score, intent_tags, budget_detected, urgency_level, is_hot_lead,
              conversation_summary, summary_updated_at
       FROM leads WHERE id = $1 AND company_id = $2`,
      [leadId, companyId]
    );
    const r = row.rows[0];
    const rawSummary = r?.conversation_summary ?? null;
    const conversation_summary = (() => {
      if (rawSummary == null || rawSummary === '') return [];
      if (Array.isArray(rawSummary)) return rawSummary;
      return String(rawSummary)
        .split(/\n/)
        .map((s) => s.replace(/^[\s•\-*]+\s*/, '').trim())
        .filter(Boolean);
    })();
    res.json({
      intent_score: r?.intent_score ?? 0,
      intent_tags: r?.intent_tags ?? [],
      budget_detected: r?.budget_detected ?? null,
      urgency_level: r?.urgency_level ?? 'unknown',
      is_hot_lead: Boolean(r?.is_hot_lead),
      conversation_summary,
      summary_updated_at: r?.summary_updated_at ?? null,
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.get('/:leadId/suggestions/latest', async (req, res) => {
  try {
    const leadId = req.params.leadId;
    const companyId = req.tenantId;
    const lead = await leadRepository.findById(companyId, leadId);
    if (!lead) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Lead not found' } });
    }
    const row = await pool.query(
      `SELECT id, conversation_id, suggestions, created_at
       FROM reply_suggestions
       WHERE lead_id = $1 AND company_id = $2 AND used_suggestion_index IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [leadId, companyId]
    );
    const rec = row.rows[0];
    if (!rec) {
      return res.json({ suggestion_id: null, suggestions: null });
    }
    const suggestions = Array.isArray(rec.suggestions) ? rec.suggestions : (typeof rec.suggestions === 'string' ? JSON.parse(rec.suggestions || '[]') : []);
    res.json({
      suggestion_id: rec.id,
      conversation_id: rec.conversation_id,
      suggestions,
      created_at: rec.created_at,
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.get('/:leadId/no-show-risk', async (req, res) => {
  try {
    const leadId = req.params.leadId;
    const lead = await leadRepository.findById(req.tenantId, leadId);
    if (!lead) return errorJson(res, 404, 'NOT_FOUND', 'Lead not found');
    const warmingService = require('../../services/warmingService');
    const { score, risk_level } = await warmingService.calculateNoShowRisk(leadId);
    res.json({ no_show_risk_score: score, risk_level });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.post('/:leadId/block', ensureLeadForCrm, async (req, res) => {
  try {
    const companyId = req.tenantId;
    const leadId = req.crmLeadId;
    const lead = await leadRepository.findById(companyId, leadId);
    if (!lead) return errorJson(res, 404, 'NOT_FOUND', 'Lead not found');
    const externalId = lead.external_id || String(leadId);
    const channel = lead.channel || 'instagram';
    await pool.query(
      `INSERT INTO blocked_users (company_id, external_id, channel, reason)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (company_id, external_id, channel) DO NOTHING`,
      [companyId, externalId, channel, 'Blocked from lead detail']
    );
    await leadRepository.update(companyId, leadId, { status: 'disqualified', pipeline_stage: 'disqualified' });
    return res.json({ success: true, blocked: true });
  } catch (err) {
    console.error('[leads] block:', err.message);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

router.put('/:leadId/assign', ensureLeadForCrm, async (req, res) => {
  try {
    const companyId = req.tenantId;
    const leadId = req.crmLeadId;
    const setter_id = req.body?.setter_id ?? null;
    if (setter_id !== null) {
      const check = await pool.query(
        'SELECT id FROM team_members WHERE id = $1 AND company_id = $2 AND is_active = true',
        [setter_id, companyId]
      );
      if (!check.rows[0]) {
        return errorJson(res, 400, 'VALIDATION_ERROR', 'setter_id not found or inactive');
      }
    }
    await leadRepository.update(companyId, leadId, { assigned_setter_id: setter_id });
    const updated = await leadRepository.findById(companyId, leadId);
    return res.json(toLeadResponse(updated));
  } catch (err) {
    console.error('[leads] assign:', err.message);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

router.put('/:leadId/attribution', async (req, res) => {
  try {
    const leadId = req.params.leadId;
    const lead = await leadRepository.findById(req.tenantId, leadId);
    if (!lead) return errorJson(res, 404, 'NOT_FOUND', 'Lead not found');
    const body = req.body || {};
    const updated = await leadRepository.update(req.tenantId, leadId, {
      source_content: body.source_content,
      source_campaign: body.source_campaign,
      assigned_setter: body.assigned_setter,
      assigned_closer: body.assigned_closer,
    });
    res.json(updated || lead);
  } catch (err) {
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

    let appointments = [];
    try {
      const apptResult = await appointmentRepository.list(req.tenantId, { lead_id: req.params.id, limit: 20 });
      appointments = (apptResult?.items || []).map((a) => ({
        id: a.id,
        appointmentType: a.appointmentType ?? a.appointment_type ?? 'call',
        status: a.status ?? 'scheduled',
        startAt: a.startAt ?? a.start_at ?? null,
        endAt: a.endAt ?? a.end_at ?? null,
        timezone: a.timezone ?? 'Europe/Zagreb',
        source: a.source ?? 'manual',
        title: a.title ?? null,
      }));
    } catch { /* appointments not critical for lead detail */ }

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
      appointments,
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

// ---- Lead Scheduling Requests ----
const { schedulingRequestRepository } = require('../../../db/repositories');
const { listSchedulingRequestsSchema } = require('../validators/schedulingRequestSchemas');

router.get('/:leadId/scheduling-requests', ensureLeadForCrm, async (req, res) => {
  try {
    const parsed = listSchedulingRequestsSchema.safeParse(req.query);
    if (!parsed.success) {
      const flat = parsed.error.flatten();
      const fieldMsgs = Object.entries(flat.fieldErrors ?? {})
        .map(([f, msgs]) => `${f}: ${(msgs || []).join(', ')}`)
        .filter(Boolean);
      const msg = flat.formErrors?.[0] || fieldMsgs.join('; ') || 'Validation failed';
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: msg } });
    }

    const companyId = req.tenantId;
    const leadId = req.crmLeadId;
    const { status, request_type, limit, offset } = parsed.data;
    const opts = { status, leadId, requestType: request_type, limit, offset };

    const [items, total] = await Promise.all([
      schedulingRequestRepository.list(companyId, opts),
      schedulingRequestRepository.count(companyId, opts),
    ]);

    res.json({ items, total });
  } catch (err) {
    console.error('[leads/:leadId/scheduling-requests] list error:', err.message);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to list lead scheduling requests');
  }
});

module.exports = router;
