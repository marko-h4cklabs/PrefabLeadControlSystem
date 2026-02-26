/**
 * Revenue tracking: deals CRUD, stats, and attribution.
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../../../db');
const { dealRepository, leadRepository } = require('../../../db/repositories');
const { createNotification } = require('../../services/notificationService');
const { errorJson } = require('../middleware/errors');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/deals — create deal, set lead pipeline_stage/deal_value/closed_at, insert pipeline_history
router.post('/', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const body = req.body || {};
    const lead_id = body.lead_id;
    const amount = body.amount != null ? Number(body.amount) : null;
    if (!lead_id || !UUID_REGEX.test(lead_id)) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'lead_id (UUID) required');
    }
    if (amount == null || isNaN(amount) || amount < 0) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'amount (non-negative number) required');
    }
    const lead = await leadRepository.findById(companyId, lead_id);
    if (!lead) return errorJson(res, 404, 'NOT_FOUND', 'Lead not found');

    const deal = await dealRepository.create({
      lead_id,
      company_id: companyId,
      amount,
      currency: body.currency ?? 'EUR',
      notes: body.notes ?? null,
      attribution_source: body.attribution_source ?? null,
      attribution_campaign: body.attribution_campaign ?? null,
      setter_name: body.setter_name ?? null,
      closer_name: body.closer_name ?? null,
    });

    const closedAt = new Date();
    await pool.query(
      `UPDATE leads SET pipeline_stage = 'closed_won', deal_value = $2, closed_at = $3, updated_at = NOW() WHERE id = $1 AND company_id = $4`,
      [lead_id, amount, closedAt, companyId]
    );
    await pool.query(
      `INSERT INTO pipeline_history (lead_id, company_id, pipeline_stage, deal_value, changed_at) VALUES ($1, $2, 'closed_won', $3, $4)`,
      [lead_id, companyId, amount, closedAt]
    );

    const setterName = body.setter_name ?? deal.setter_name;
    if (setterName && typeof setterName === 'string') {
      const tm = await pool.query(
        'SELECT id, name FROM team_members WHERE company_id = $1 AND LOWER(TRIM(name)) = LOWER(TRIM($2)) AND is_active = true',
        [companyId, setterName]
      );
      if (tm.rows[0]) {
        const setterId = tm.rows[0].id;
        const today = closedAt.toISOString().slice(0, 10);
        await pool.query(
          `INSERT INTO setter_performance (company_id, setter_id, setter_name, date, deals_closed, revenue_attributed)
           VALUES ($1, $2, $3, $4::date, 1, $5)
           ON CONFLICT (company_id, setter_id, date) DO UPDATE SET
             deals_closed = setter_performance.deals_closed + 1,
             revenue_attributed = setter_performance.revenue_attributed + $5`,
          [companyId, setterId, setterName.trim(), today, amount]
        );
      }
    }

    createNotification(companyId, 'deal_logged', '💰 Deal Logged', `€${amount} deal closed with ${lead.name || 'lead'}`, lead_id).catch(() => {});

    res.status(201).json(deal);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// GET /api/deals — list deals, ?from=, ?to=, ?setter=
router.get('/', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const from = req.query.from ?? null;
    const to = req.query.to ?? null;
    const setter = req.query.setter ?? null;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const items = await dealRepository.list(companyId, { from, to, setter_name: setter, limit, offset });
    const total = await dealRepository.count(companyId, { from, to, setter_name: setter });
    res.json({ items, total });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// GET /api/deals/stats?period=day|week|month|year  OR  ?from=&to=
router.get('/stats', async (req, res) => {
  try {
    const companyId = req.tenantId;
    let from = req.query.from ?? null;
    let to = req.query.to ?? null;

    // Convenience: ?period= calculates from/to automatically
    if (req.query.period && !from && !to) {
      const now = new Date();
      to = now.toISOString().slice(0, 10);
      switch (req.query.period) {
        case 'day':   from = to; break;
        case 'week':  { const d = new Date(now); d.setDate(d.getDate() - 7); from = d.toISOString().slice(0, 10); break; }
        case 'month': { const d = new Date(now); d.setMonth(d.getMonth() - 1); from = d.toISOString().slice(0, 10); break; }
        case 'year':  { const d = new Date(now); d.setFullYear(d.getFullYear() - 1); from = d.toISOString().slice(0, 10); break; }
      }
    }

    const stats = await dealRepository.getStats(companyId, { from, to });
    res.json(stats);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// PUT /api/deals/:id
router.put('/:id', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const id = req.params.id;
    if (!id || !UUID_REGEX.test(id)) return errorJson(res, 400, 'VALIDATION_ERROR', 'Valid deal ID required');
    const body = req.body || {};
    const updated = await dealRepository.update(companyId, id, {
      amount: body.amount,
      currency: body.currency,
      status: body.status,
      notes: body.notes,
      attribution_source: body.attribution_source,
      attribution_campaign: body.attribution_campaign,
      setter_name: body.setter_name,
      closer_name: body.closer_name,
    });
    if (!updated) return errorJson(res, 404, 'NOT_FOUND', 'Deal not found');
    res.json(updated);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// DELETE /api/deals/:id — soft delete
router.delete('/:id', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const id = req.params.id;
    if (!id || !UUID_REGEX.test(id)) return errorJson(res, 400, 'VALIDATION_ERROR', 'Valid deal ID required');
    const ok = await dealRepository.softDelete(companyId, id);
    if (!ok) return errorJson(res, 404, 'NOT_FOUND', 'Deal not found');
    res.json({ deleted: true, id });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

module.exports = router;
