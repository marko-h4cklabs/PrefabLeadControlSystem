const express = require('express');
const router = express.Router();
const {
  chatbotCompanyInfoRepository,
  chatbotBehaviorRepository,
  chatbotQuoteFieldsRepository,
} = require('../../../db/repositories');
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
    const info = await chatbotCompanyInfoRepository.get(req.tenantId);
    res.json({
      website_url: info.website_url,
      business_description: info.business_description,
      additional_notes: info.additional_notes,
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
    const saved = await chatbotCompanyInfoRepository.upsert(req.tenantId, parsed.data);
    res.json({
      website_url: saved.website_url,
      business_description: saved.business_description,
      additional_notes: saved.additional_notes,
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.post('/company-info/scrape', async (req, res) => {
  try {
    const info = await chatbotCompanyInfoRepository.get(req.tenantId);
    if (!info.website_url || info.website_url.trim() === '') {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'website_url is required to trigger scrape' },
      });
    }
    await chatbotCompanyInfoRepository.appendScrapeNote(req.tenantId);
    res.json({ status: 'queued' });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.get('/behavior', async (req, res) => {
  try {
    const behavior = await chatbotBehaviorRepository.get(req.tenantId);
    res.json(behavior);
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
    res.json({ fields });
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
    const system_context = buildSystemContext(companyInfo, behavior, quoteFields);
    res.json({ system_context });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

module.exports = router;
