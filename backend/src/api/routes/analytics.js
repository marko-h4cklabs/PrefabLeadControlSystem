const express = require('express');
const router = express.Router();
const { analyticsRepository } = require('../../../db/repositories');
const { analyticsQuerySchema } = require('../validators/analyticsSchemas');
const { errorJson } = require('../middleware/errors');

router.get('/dashboard', async (req, res) => {
  try {
    const parsed = analyticsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const err = parsed.error.flatten();
      const msg = err.formErrors?.[0] ?? Object.values(err.fieldErrors ?? {})?.flat?.()?.[0] ?? 'Invalid query';
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: msg } });
    }
    const { startDate, endDate, source, channel } = parsed.data;
    const companyId = req.tenantId;

    const [summary, leadsOverTime, channelBreakdown, statusBreakdown, fieldCompletion, topSignals] = await Promise.all([
      analyticsRepository.getFullSummary(companyId, { startDate, endDate, source, channel }),
      analyticsRepository.getLeadsOverTime(companyId, { startDate, endDate, source, channel }),
      analyticsRepository.getChannelBreakdown(companyId, { startDate, endDate, source, channel }),
      analyticsRepository.getStatusBreakdown(companyId, { startDate, endDate, source, channel }),
      analyticsRepository.getFieldCompletion(companyId, { startDate, endDate, source, channel }),
      analyticsRepository.getTopSignals(companyId, { startDate, endDate, source, channel }),
    ]);

    res.json({
      range: { startDate, endDate, source: source ?? 'all', channel: channel ?? 'all' },
      summary,
      leadsOverTime,
      channelBreakdown,
      statusBreakdown,
      fieldCompletion,
      topSignals,
    });
  } catch (err) {
    if (err.code === '42P01') {
      return res.status(500).json({ error: { code: 'DB_ERROR', message: 'Analytics tables not available' } });
    }
    if (process.env.NODE_ENV !== 'production') {
      console.error('[analytics] dashboard error:', err.message);
    }
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.get('/summary', async (req, res) => {
  try {
    const parsed = analyticsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const err = parsed.error.flatten();
      const msg = err.formErrors?.[0] ?? Object.values(err.fieldErrors ?? {})?.flat?.()?.[0] ?? 'Invalid query';
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: msg } });
    }
    const { startDate, endDate, source, channel } = parsed.data;
    const summary = await analyticsRepository.getFullSummary(req.tenantId, { startDate, endDate, source, channel });
    res.json(summary);
  } catch (err) {
    if (err.code === '42P01') {
      return res.status(500).json({ error: { code: 'DB_ERROR', message: 'Analytics tables not available' } });
    }
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.get('/leads-over-time', async (req, res) => {
  try {
    const parsed = analyticsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const err = parsed.error.flatten();
      const msg = err.formErrors?.[0] ?? Object.values(err.fieldErrors ?? {})?.flat?.()?.[0] ?? 'Invalid query';
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: msg } });
    }
    const { startDate, endDate, source, channel } = parsed.data;
    const data = await analyticsRepository.getLeadsOverTime(req.tenantId, { startDate, endDate, source, channel });
    res.json(data);
  } catch (err) {
    if (err.code === '42P01') return res.status(500).json({ error: { code: 'DB_ERROR', message: 'Analytics tables not available' } });
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.get('/channel-breakdown', async (req, res) => {
  try {
    const parsed = analyticsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const err = parsed.error.flatten();
      const msg = err.formErrors?.[0] ?? Object.values(err.fieldErrors ?? {})?.flat?.()?.[0] ?? 'Invalid query';
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: msg } });
    }
    const { startDate, endDate, source, channel } = parsed.data;
    const data = await analyticsRepository.getChannelBreakdown(req.tenantId, { startDate, endDate, source, channel });
    res.json(data);
  } catch (err) {
    if (err.code === '42P01') return res.status(500).json({ error: { code: 'DB_ERROR', message: 'Analytics tables not available' } });
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.get('/status-breakdown', async (req, res) => {
  try {
    const parsed = analyticsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const err = parsed.error.flatten();
      const msg = err.formErrors?.[0] ?? Object.values(err.fieldErrors ?? {})?.flat?.()?.[0] ?? 'Invalid query';
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: msg } });
    }
    const { startDate, endDate, source, channel } = parsed.data;
    const data = await analyticsRepository.getStatusBreakdown(req.tenantId, { startDate, endDate, source, channel });
    res.json(data);
  } catch (err) {
    if (err.code === '42P01') return res.status(500).json({ error: { code: 'DB_ERROR', message: 'Analytics tables not available' } });
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.get('/field-completion', async (req, res) => {
  try {
    const parsed = analyticsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const err = parsed.error.flatten();
      const msg = err.formErrors?.[0] ?? Object.values(err.fieldErrors ?? {})?.flat?.()?.[0] ?? 'Invalid query';
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: msg } });
    }
    const { startDate, endDate, source, channel } = parsed.data;
    const data = await analyticsRepository.getFieldCompletion(req.tenantId, { startDate, endDate, source, channel });
    res.json(data);
  } catch (err) {
    if (err.code === '42P01') return res.status(500).json({ error: { code: 'DB_ERROR', message: 'Analytics tables not available' } });
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.get('/top-signals', async (req, res) => {
  try {
    const parsed = analyticsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const err = parsed.error.flatten();
      const msg = err.formErrors?.[0] ?? Object.values(err.fieldErrors ?? {})?.flat?.()?.[0] ?? 'Invalid query';
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: msg } });
    }
    const { startDate, endDate, source, channel } = parsed.data;
    const data = await analyticsRepository.getTopSignals(req.tenantId, { startDate, endDate, source, channel });
    res.json(data);
  } catch (err) {
    if (err.code === '42P01') return res.status(500).json({ error: { code: 'DB_ERROR', message: 'Analytics tables not available' } });
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

module.exports = router;
