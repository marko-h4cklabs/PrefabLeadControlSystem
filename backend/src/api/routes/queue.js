const express = require('express');
const router = express.Router();
const queueService = require('../../../services/queueService');
const { errorJson } = require('../middleware/errors');

// GET /api/queue/stats
router.get('/stats', async (req, res) => {
  try {
    const data = await queueService.getQueueStats();
    res.json({ data });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// POST /api/queue/follow-up
router.post('/follow-up', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { leadId, lead_id, type, delayMinutes, delay_minutes, message } = req.body || {};
    const lid = leadId || lead_id;
    const delay = delayMinutes ?? delay_minutes ?? 60;
    if (!lid || !type) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'leadId and type are required');
    }
    const validTypes = ['no_reply', 'post_quote', 'cold_lead', 'custom'];
    if (!validTypes.includes(type)) {
      return errorJson(res, 400, 'VALIDATION_ERROR', `type must be one of: ${validTypes.join(', ')}`);
    }
    if (type === 'custom' && (!message || typeof message !== 'string')) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'message is required for custom type');
    }
    const delayMs = Math.max(0, (parseInt(delay, 10) || 0) * 60000);
    const payload = type === 'custom' ? { message } : {};
    const result = await queueService.scheduleFollowUp(lid, companyId, type, delayMs, payload);
    if (!result.queued) {
      return res.status(409).json({
        data: { queued: false, reason: result.reason ?? 'Job already exists', jobId: result.jobId },
      });
    }
    res.json({ data: { queued: true, jobId: result.jobId } });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// DELETE /api/queue/follow-up/:leadId/:type
router.delete('/follow-up/:leadId/:type', async (req, res) => {
  try {
    const { leadId, type } = req.params;
    if (!leadId || !type) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'leadId and type are required');
    }
    const cancelled = await queueService.cancelFollowUp(leadId, type);
    res.json({ data: { cancelled } });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

module.exports = router;
