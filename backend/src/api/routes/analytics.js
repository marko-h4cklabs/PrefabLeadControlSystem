const express = require('express');
const router = express.Router();
const { analyticsRepository, dealRepository } = require('../../../db/repositories');
const { analyticsQuerySchema } = require('../validators/analyticsSchemas');
const { errorJson } = require('../middleware/errors');

const ANALYTICS_DEBUG = process.env.ANALYTICS_DEBUG === 'true';

router.get('/overview', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { pool } = require('../../../db');
    const [summary, dealsStats, warmingCount] = await Promise.all([
      analyticsRepository.getFullSummary(companyId, { days: 30 }).catch(() => null),
      dealRepository.getStats(companyId).catch(() => null),
      pool.query(
        'SELECT COUNT(*)::int AS n FROM warming_enrollments WHERE company_id = $1 AND status = $2',
        [companyId, 'active']
      ).then((r) => parseInt(r.rows[0]?.n, 10) || 0).catch(() => 0),
    ]);
    res.json({
      summary: summary ?? null,
      deals_stats: dealsStats ?? null,
      warming_active_enrollments: warmingCount,
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.get('/dashboard', async (req, res) => {
  try {
    const parsed = analyticsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const err = parsed.error.flatten();
      const msg = err.formErrors?.[0] ?? Object.values(err.fieldErrors ?? {})?.flat?.()?.[0] ?? 'Invalid query';
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: msg } });
    }
    const { startDate, endDate, days, source, channel } = parsed.data;
    const companyId = req.tenantId;
    const appliedFilters = { range: parsed.data.range ?? '30', source: source ?? 'all', channel: channel ?? 'all' };
    const opts = { days, startDate, endDate, source, channel };

    const [
      summary,
      leadsOverTime,
      channelBreakdown,
      statusBreakdown,
      fieldCompletion,
      topSignals,
      availableChannels,
      rawCounts,
      dealsStats,
    ] = await Promise.all([
      analyticsRepository.getFullSummary(companyId, opts),
      analyticsRepository.getLeadsOverTime(companyId, opts),
      analyticsRepository.getChannelBreakdown(companyId, opts),
      analyticsRepository.getStatusBreakdown(companyId, opts),
      analyticsRepository.getFieldCompletion(companyId, opts),
      analyticsRepository.getTopSignals(companyId, opts),
      analyticsRepository.getAvailableChannels(companyId, opts),
      ANALYTICS_DEBUG ? analyticsRepository.getRawCounts(companyId, opts) : Promise.resolve(null),
      dealRepository.getStats(companyId, { from: startDate ?? null, to: endDate ?? null }).catch(() => null),
    ]);

    const dataAsOf = new Date().toISOString();
    if (ANALYTICS_DEBUG) {
      console.info('[analytics] dashboard', {
        userId: req.user?.id,
        tenantId: companyId,
        range: appliedFilters.range,
        source: appliedFilters.source,
        channel: appliedFilters.channel,
        rawLeadCount: rawCounts?.totalForTenant ?? 0,
        filteredLeadCount: rawCounts?.totalAfterFilters ?? 0,
        sourcesFound: summary ? { inbox: summary.inboxCount, simulation: summary.simulationCount } : null,
        channelsFound: availableChannels?.length ?? 0,
      });
    }

    const payload = {
      range: { startDate, endDate, source: appliedFilters.source, channel: appliedFilters.channel },
      applied_filters: appliedFilters,
      data_as_of: dataAsOf,
      available_channels: availableChannels ?? [],
      summary,
      deals_stats: dealsStats ?? null,
      leadsOverTime,
      channelBreakdown,
      statusBreakdown,
      fieldCompletion,
      topSignals,
    };
    if (ANALYTICS_DEBUG && rawCounts) {
      payload.debug = {
        tenantId: companyId,
        filters: appliedFilters,
        rawLeadCount: rawCounts.totalForTenant,
        filteredLeadCount: rawCounts.totalAfterFilters,
        sourcesFound: summary ? { inbox: summary.inboxCount, simulation: summary.simulationCount } : null,
        channelsFound: availableChannels ?? [],
      };
    }
    res.json(payload);
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
    const { startDate, endDate, days, source, channel } = parsed.data;
    const summary = await analyticsRepository.getFullSummary(req.tenantId, { days, startDate, endDate, source, channel });
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
    const { startDate, endDate, days, source, channel } = parsed.data;
    const data = await analyticsRepository.getLeadsOverTime(req.tenantId, { days, startDate, endDate, source, channel });
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
    const { startDate, endDate, days, source, channel } = parsed.data;
    const data = await analyticsRepository.getChannelBreakdown(req.tenantId, { days, startDate, endDate, source, channel });
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
    const { startDate, endDate, days, source, channel } = parsed.data;
    const data = await analyticsRepository.getStatusBreakdown(req.tenantId, { days, startDate, endDate, source, channel });
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
    const { startDate, endDate, days, source, channel } = parsed.data;
    const data = await analyticsRepository.getFieldCompletion(req.tenantId, { days, startDate, endDate, source, channel });
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
    const { startDate, endDate, days, source, channel } = parsed.data;
    const data = await analyticsRepository.getTopSignals(req.tenantId, { days, startDate, endDate, source, channel });
    res.json(data);
  } catch (err) {
    if (err.code === '42P01') return res.status(500).json({ error: { code: 'DB_ERROR', message: 'Analytics tables not available' } });
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

module.exports = router;
