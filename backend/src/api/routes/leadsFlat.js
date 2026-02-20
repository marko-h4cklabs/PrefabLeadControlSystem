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
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid query parameters',
          details: parsed.error.flatten().fieldErrors,
        },
      });
    }
    const { limit, offset, status, status_id } = parsed.data;
    const leads = await leadRepository.findAll(req.tenantId, {
      status,
      status_id,
      limit,
      offset,
    });
    const total = await leadRepository.count(req.tenantId, { status, status_id });
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
    const { status_id } = req.body ?? {};
    if (!status_id || typeof status_id !== 'string') {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'status_id (uuid) is required' },
      });
    }
    const lead = await leadRepository.setStatus(req.tenantId, req.params.id, status_id);
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
