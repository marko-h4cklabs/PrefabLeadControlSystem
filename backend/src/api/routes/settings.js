const express = require('express');
const router = express.Router();
const { pool } = require('../../../db');
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

/**
 * Convert camelCase DTO from repository to snake_case for merging with Zod output.
 * This ensures the merge uses one naming convention so upsert picks the right values.
 */
function dtoToSnake(dto) {
  return {
    enabled: dto.enabled,
    timezone: dto.timezone,
    working_hours: dto.workingHours,
    slot_duration_minutes: dto.slotDurationMinutes,
    buffer_before_minutes: dto.bufferBeforeMinutes,
    buffer_after_minutes: dto.bufferAfterMinutes,
    min_notice_hours: dto.minNoticeHours,
    max_days_ahead: dto.maxDaysAhead,
    allowed_appointment_types: dto.allowedAppointmentTypes,
    allow_manual_booking_from_lead: dto.allowManualBookingFromLead,
    chatbot_offer_booking: dto.chatbotOfferBooking,
    reminder_defaults: dto.reminderDefaults,
    chatbot_booking_mode: dto.chatbotBookingMode,
    chatbot_booking_prompt_style: dto.chatbotBookingPromptStyle,
    chatbot_collect_booking_after_quote: dto.chatbotCollectBookingAfterQuote,
    chatbot_booking_requires_name: dto.chatbotBookingRequiresName,
    chatbot_booking_requires_phone: dto.chatbotBookingRequiresPhone,
    chatbot_booking_default_type: dto.chatbotBookingDefaultType,
    chatbot_allow_user_proposed_time: dto.chatbotAllowUserProposedTime,
    chatbot_show_slots_when_available: dto.chatbotShowSlotsWhenAvailable,
  };
}

router.get('/scheduling', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const settings = await schedulingSettingsRepository.get(companyId);
    if (process.env.NODE_ENV !== 'production') {
      console.debug('[settings/scheduling] GET response:', { companyId, chatbotOfferBooking: settings.chatbotOfferBooking, chatbotBookingMode: settings.chatbotBookingMode });
    }
    res.json(settings);
  } catch (err) {
    console.error('[settings/scheduling] GET error:', err.message);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to load scheduling settings');
  }
});

// ---- Operating mode (autopilot / copilot) ----

const VALID_OPERATING_MODES = ['autopilot', 'copilot'];

router.get('/mode', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const result = await pool.query(
      'SELECT operating_mode FROM companies WHERE id = $1',
      [companyId]
    );
    const row = result.rows[0];
    const operating_mode = row?.operating_mode && VALID_OPERATING_MODES.includes(row.operating_mode)
      ? row.operating_mode
      : null;
    res.json({ operating_mode });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.put('/mode', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { operating_mode } = req.body ?? {};
    if (!operating_mode || !VALID_OPERATING_MODES.includes(operating_mode)) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'operating_mode must be "autopilot" or "copilot"' },
      });
    }
    await pool.query(
      'UPDATE companies SET operating_mode = $2 WHERE id = $1',
      [companyId, operating_mode]
    );
    res.json({ operating_mode });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ---- ManyChat settings ----

function maskApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== 'string') return null;
  const s = apiKey.trim();
  if (s.length === 0) return null;
  if (s.length <= 6) return '*'.repeat(s.length);
  return '*'.repeat(s.length - 6) + s.slice(-6);
}

router.get('/manychat', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const result = await pool.query(
      'SELECT manychat_api_key, manychat_page_id FROM companies WHERE id = $1',
      [companyId]
    );
    const row = result.rows[0];
    if (!row) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Company not found' } });
    }
    const rawKey = row.manychat_api_key ?? null;
    res.json({
      manychat_api_key: maskApiKey(rawKey),
      manychat_page_id: row.manychat_page_id ?? null,
      has_api_key: !!(rawKey && String(rawKey).trim()),
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.put('/manychat', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const companyId = req.tenantId;
    const body = req.body ?? {};
    const updates = [];
    const params = [companyId];
    let idx = 2;

    if ('manychat_api_key' in body) {
      updates.push(`manychat_api_key = $${idx++}`);
      params.push(body.manychat_api_key ?? null);
    }
    if ('manychat_page_id' in body) {
      updates.push(`manychat_page_id = $${idx++}`);
      params.push(body.manychat_page_id ?? null);
    }
    if (updates.length === 0) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No fields to update' } });
    }
    await pool.query(
      `UPDATE companies SET ${updates.join(', ')} WHERE id = $1`,
      params
    );
    res.json({ success: true });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.put('/scheduling', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const companyId = req.tenantId;
    const body = req.body || {};
    console.debug('[settings/scheduling] PUT raw body keys:', Object.keys(body));

    const parsed = schedulingSettingsSchema.safeParse(body);
    if (!parsed.success) {
      const flat = parsed.error.flatten();
      const fieldMsgs = Object.entries(flat.fieldErrors ?? {})
        .map(([f, msgs]) => `${f}: ${(msgs || []).join(', ')}`)
        .filter(Boolean);
      const msg = flat.formErrors?.[0] || fieldMsgs.join('; ') || 'Validation failed';
      const wh = body.working_hours ?? body.workingHours;
      console.error('[settings/scheduling] PUT validation failed:', {
        bodyKeys: Object.keys(body),
        workingHoursType: wh == null ? 'null' : Array.isArray(wh) ? 'array' : typeof wh,
        workingHoursFirstItem: Array.isArray(wh) ? JSON.stringify(wh[0]) : undefined,
        errors: fieldMsgs,
      });
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: msg, fields: flat.fieldErrors },
      });
    }

    console.debug('[settings/scheduling] PUT after normalization:', {
      enabled: parsed.data.enabled,
      chatbot_offer_booking: parsed.data.chatbot_offer_booking,
      chatbot_booking_mode: parsed.data.chatbot_booking_mode,
    });

    const currentDto = await schedulingSettingsRepository.get(companyId);
    const current = dtoToSnake(currentDto);

    const merged = { ...current };
    for (const [key, val] of Object.entries(parsed.data)) {
      if (val !== undefined) merged[key] = val;
    }

    const saved = await schedulingSettingsRepository.upsert(companyId, merged);
    console.debug('[settings/scheduling] PUT saved:', {
      enabled: saved.enabled,
      chatbotOfferBooking: saved.chatbotOfferBooking,
      chatbot_booking_enabled: saved.chatbot_booking_enabled,
    });
    res.json(saved);
  } catch (err) {
    console.error('[settings/scheduling] PUT error:', err.message);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to save scheduling settings');
  }
});

module.exports = router;
