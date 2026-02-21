const express = require('express');
const router = express.Router();
const { notificationSettingsRepository, schedulingSettingsRepository } = require('../../../db/repositories');
const { requireRole } = require('../middleware/auth');
const { errorJson } = require('../middleware/errors');
const { schedulingSettingsSchema } = require('../validators/schedulingSettingsSchema');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(s) {
  return typeof s === 'string' && s.trim().length > 0 && EMAIL_REGEX.test(s.trim());
}

const putBodySchema = {
  email_enabled: (v) => typeof v === 'boolean',
  email_recipients: (v) => Array.isArray(v) && v.every((e) => typeof e === 'string' && isValidEmail(e)),
  notify_new_inquiry_inbox: (v) => typeof v === 'boolean',
  notify_new_inquiry_simulation: (v) => typeof v === 'boolean',
};

function validatePut(body) {
  const errs = [];
  if (body.email_enabled !== undefined && !putBodySchema.email_enabled(body.email_enabled)) {
    errs.push({ field: 'email_enabled', message: 'must be boolean' });
  }
  if (body.email_recipients !== undefined) {
    if (!Array.isArray(body.email_recipients)) {
      errs.push({ field: 'email_recipients', message: 'must be array of valid emails' });
    } else if (!body.email_recipients.every((e) => typeof e === 'string' && isValidEmail(e))) {
      errs.push({ field: 'email_recipients', message: 'all items must be valid email addresses' });
    }
  }
  if (body.notify_new_inquiry_inbox !== undefined && !putBodySchema.notify_new_inquiry_inbox(body.notify_new_inquiry_inbox)) {
    errs.push({ field: 'notify_new_inquiry_inbox', message: 'must be boolean' });
  }
  if (body.notify_new_inquiry_simulation !== undefined && !putBodySchema.notify_new_inquiry_simulation(body.notify_new_inquiry_simulation)) {
    errs.push({ field: 'notify_new_inquiry_simulation', message: 'must be boolean' });
  }
  return errs;
}

router.get('/notifications', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const settings = await notificationSettingsRepository.get(companyId);
    res.json(settings);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.put('/notifications', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const companyId = req.tenantId;
    const body = req.body ?? {};
    const errs = validatePut(body);
    if (errs.length > 0) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid input',
          details: errs,
        },
      });
    }

    const current = await notificationSettingsRepository.get(companyId);
    const merged = {
      email_enabled: body.email_enabled !== undefined ? body.email_enabled : current.email_enabled,
      email_recipients: body.email_recipients !== undefined ? body.email_recipients : current.email_recipients,
      notify_new_inquiry_inbox: body.notify_new_inquiry_inbox !== undefined ? body.notify_new_inquiry_inbox : current.notify_new_inquiry_inbox,
      notify_new_inquiry_simulation: body.notify_new_inquiry_simulation !== undefined ? body.notify_new_inquiry_simulation : current.notify_new_inquiry_simulation,
    };
    const saved = await notificationSettingsRepository.upsert(companyId, merged);
    res.json(saved);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ---- Scheduling settings ----

router.get('/scheduling', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const settings = await schedulingSettingsRepository.get(companyId);
    res.json(settings);
  } catch (err) {
    console.error('[settings/scheduling] GET error:', err.message);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to load scheduling settings');
  }
});

router.put('/scheduling', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const companyId = req.tenantId;
    const parsed = schedulingSettingsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const flat = parsed.error.flatten();
      const fieldMsgs = Object.entries(flat.fieldErrors ?? {})
        .map(([f, msgs]) => `${f}: ${(msgs || []).join(', ')}`)
        .filter(Boolean);
      const msg = flat.formErrors?.[0] || fieldMsgs.join('; ') || 'Validation failed';
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: msg, fields: flat.fieldErrors },
      });
    }

    const current = await schedulingSettingsRepository.get(companyId);
    const merged = { ...current };
    for (const [key, val] of Object.entries(parsed.data)) {
      if (val !== undefined) merged[key] = val;
    }

    const saved = await schedulingSettingsRepository.upsert(companyId, merged);
    res.json(saved);
  } catch (err) {
    console.error('[settings/scheduling] PUT error:', err.message);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to save scheduling settings');
  }
});

module.exports = router;
