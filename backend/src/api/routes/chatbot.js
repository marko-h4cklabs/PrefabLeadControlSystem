const express = require('express');
const router = express.Router();
const {
  chatbotCompanyInfoRepository,
  chatbotBehaviorRepository,
  chatbotQuoteFieldsRepository,
} = require('../../../db/repositories');
const { sendScrapeJob } = require('../../queue');
const { buildSystemContext } = require('../../services/chatbotSystemContext');
const {
  companyInfoBodySchema,
  behaviorBodySchema,
  quoteFieldsBodySchema,
} = require('../validators/chatbotSchemas');
const { errorJson } = require('../middleware/errors');

function validationError(res, parsed) {
  return res.status(400).json({
    error: {
      code: 'VALIDATION_ERROR',
      message: parsed.error?.message ?? 'Validation failed',
      details: parsed.error?.flatten?.()?.fieldErrors,
    },
  });
}

router.get('/company-info', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.set('X-Poll-Interval', '5000');
    const info = await chatbotCompanyInfoRepository.get(req.tenantId);
    res.json({
      website_url: info.website_url ?? '',
      business_description: info.business_description ?? '',
      additional_notes: info.additional_notes ?? '',
      scrape_status: info.scrape_status ?? 'idle',
      scrape_started_at: info.scrape_started_at,
      scrape_finished_at: info.scrape_finished_at,
      scrape_error: info.scrape_error,
      scraped_summary: info.scraped_summary,
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.put('/company-info', async (req, res) => {
  try {
    const parsed = companyInfoBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return validationError(res, parsed);
    }
    const data = { ...parsed.data };
    const inProgress = ['queued', 'running', 'summarizing'];
    const info = await chatbotCompanyInfoRepository.get(req.tenantId);
    if (inProgress.includes(info.scrape_status) && data.business_description !== undefined) {
      delete data.business_description;
    }
    const saved = await chatbotCompanyInfoRepository.upsert(req.tenantId, data);
    res.json({
      website_url: saved.website_url,
      business_description: saved.business_description,
      additional_notes: saved.additional_notes,
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

function normalizeAndValidateUrl(raw) {
  let s = (raw || '').trim();
  if (!s) return null;
  if (s.startsWith('//')) s = 'https:' + s;
  else if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    new URL(s);
    return s;
  } catch {
    return null;
  }
}

router.post('/company-info/scrape', async (req, res) => {
  try {
    const websiteUrl = (req.body?.website_url ?? '').trim();
    if (!websiteUrl) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'website_url is required. Enter the website URL first, then click Scrape.',
        },
      });
    }
    const normalized = normalizeAndValidateUrl(websiteUrl);
    if (!normalized) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'website_url must be a valid URL' },
      });
    }
    await chatbotCompanyInfoRepository.upsert(req.tenantId, { website_url: normalized });
    await chatbotCompanyInfoRepository.setScrapeQueued(req.tenantId, normalized);
    try {
      await sendScrapeJob(req.tenantId);
    } catch (queueErr) {
      console.error('[scrape] Queue error, falling back to inline:', queueErr.message);
      const { startScrapeJob } = require('../../services/scrapeService');
      startScrapeJob(req.tenantId);
    }
    res.status(202).json({ status: 'queued' });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.get('/behavior', async (req, res) => {
  try {
    const behavior = await chatbotBehaviorRepository.get(req.tenantId);
    res.json({
      tone: behavior.tone ?? 'professional',
      response_length: behavior.response_length ?? 'medium',
      emojis_enabled: behavior.emojis_enabled ?? false,
      persona_style: behavior.persona_style ?? 'busy',
      forbidden_topics: behavior.forbidden_topics ?? [],
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.put('/behavior', async (req, res) => {
  try {
    const parsed = behaviorBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return validationError(res, parsed);
    }
    const saved = await chatbotBehaviorRepository.upsert(req.tenantId, parsed.data);
    res.json(saved);
  } catch (err) {
    if (err.code === '23514') {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid enum value for tone, response_length, or persona_style' },
      });
    }
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.get('/quote-fields', async (req, res) => {
  try {
    const fields = await chatbotQuoteFieldsRepository.list(req.tenantId);
    res.json({ fields: fields ?? [] });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.put('/quote-fields', async (req, res) => {
  try {
    const parsed = quoteFieldsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return validationError(res, parsed);
    }
    const fields = await chatbotQuoteFieldsRepository.replace(req.tenantId, parsed.data.fields);
    res.json({ fields });
  } catch (err) {
    if (err.code === '23514') {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid type or priority' },
      });
    }
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.get('/system-context', async (req, res) => {
  try {
    const [companyInfo, behavior, quoteFields] = await Promise.all([
      chatbotCompanyInfoRepository.get(req.tenantId),
      chatbotBehaviorRepository.get(req.tenantId),
      chatbotQuoteFieldsRepository.list(req.tenantId),
    ]);
    const ctx = buildSystemContext(
      companyInfo ?? { website_url: '', business_description: '', additional_notes: '' },
      behavior ?? { tone: 'professional', response_length: 'medium', emojis_enabled: false, persona_style: 'busy', forbidden_topics: [] },
      quoteFields ?? []
    );
    res.json({ systemContext: ctx, system_context: ctx });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

module.exports = router;
