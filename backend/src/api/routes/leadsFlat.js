const express = require('express');
const router = express.Router();
const { leadRepository, companyLeadStatusesRepository } = require('../../../db/repositories');
const { errorJson } = require('../middleware/errors');
const {
  listLeadsQuerySchema,
  createLeadBodySchema,
  updateLeadBodySchema,
} = require('../validators/leadSchemas');

function toLeadResponse(lead) {
  const out = {
    id: lead.id,
    channel: lead.channel,
    external_id: lead.external_id,
    score: lead.score ?? 0,
    status: lead.status,
    created_at: lead.created_at,
    status_id: lead.status_id ?? null,
    status_name: lead.status_obj?.name ?? null,
  };
  if (lead.status_obj) {
    out.status_obj = lead.status_obj;
  }
  return out;
}

router.get('/statuses', async (req, res) => {
  try {
    const statuses = await companyLeadStatusesRepository.list(req.tenantId);
    res.json({ statuses: statuses ?? [] });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.get('/', async (req, res) => {
  try {
    const parsed = listLeadsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const err = parsed.error.flatten();
      if (process.env.NODE_ENV !== 'production') {
        console.info('[leads] rejected query params:', req.query, 'errors:', err.fieldErrors);
      }
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: err.formErrors?.join?.(' ') || 'Invalid query parameters',
          details: err.fieldErrors,
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
    res.json({
      leads: leads.map(toLeadResponse),
      total,
    });
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

router.put('/:id/status', async (req, res) => {
  try {
    const { statusId, status_id } = req.body ?? {};
    const id = statusId || status_id;
    if (!id || typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'statusId (uuid) is required in body' },
      });
    }
    const lead = await leadRepository.setStatus(req.tenantId, req.params.id, id);
    if (!lead) {
      return errorJson(res, 404, 'NOT_FOUND', 'Lead not found or status invalid for company');
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
