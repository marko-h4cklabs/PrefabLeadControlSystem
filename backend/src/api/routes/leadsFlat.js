const express = require('express');
const router = express.Router();
const {
  leadRepository,
  companyLeadStatusesRepository,
  conversationRepository,
} = require('../../../db/repositories');
const { errorJson } = require('../middleware/errors');
const { computeFieldsState } = require('../../chat/fieldsState');
const {
  listLeadsQuerySchema,
  createLeadBodySchema,
  updateLeadBodySchema,
  patchNameBodySchema,
  patchStatusBodySchema,
} = require('../validators/leadSchemas');

function toLeadResponse(lead) {
  const out = {
    id: lead.id,
    channel: lead.channel,
    external_id: lead.external_id,
    name: lead.name ?? null,
    status: lead.status_name ?? lead.status,
    status_id: lead.status_id ?? null,
    created_at: lead.created_at,
    updated_at: lead.updated_at,
  };
  return out;
}

function toLeadPublic(lead) {
  return {
    channel: lead.channel,
    name: lead.name ?? null,
    status: lead.status_name ?? lead.status,
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
    const { limit, offset, status, statusId, status_id } = parsed.data;
    const filterStatusId = statusId || status_id;
    const leads = await leadRepository.findAll(req.tenantId, {
      status,
      status_id: filterStatusId,
      limit,
      offset,
    });
    const total = await leadRepository.count(req.tenantId, { status, status_id: filterStatusId });
    res.json({
      leads: Array.isArray(leads) ? leads.map(toLeadResponse) : [],
      total: typeof total === 'number' ? total : 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Internal server error' });
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
    const collectedFromParsed = parsedFieldsToCollected(parsedFields, orderedSnapshot);
    const { required_infos, collected_infos } = computeFieldsState(orderedSnapshot, collectedFromParsed);
    res.json({
      lead: toLeadPublic(lead),
      collected_infos: (collected_infos ?? []).map((c) => ({
        name: c.name,
        type: c.type ?? 'text',
        value: c.value,
        units: c.units ?? null,
      })),
      required_infos_missing: (required_infos ?? []).map((f) => ({
        name: f.name,
        type: f.type ?? 'text',
        units: f.units ?? null,
      })),
    });
  } catch (err) {
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
    const { channel, external_id } = parsed.data;
    const lead = await leadRepository.create(req.tenantId, {
      channel,
      external_id,
    });
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
