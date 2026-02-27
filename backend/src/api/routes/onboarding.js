/**
 * Onboarding progress and completion. All routes require auth + tenant.
 */
const logger = require('../../lib/logger');
const express = require('express');
const router = express.Router();
const { pool } = require('../../../db');
const chatbotBehaviorRepository = require('../../../db/repositories/chatbotBehaviorRepository');
const { errorJson } = require('../middleware/errors');

router.get('/status', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const companyRow = await pool.query(
      `SELECT name, onboarding_completed, onboarding_step, manychat_connected, operating_mode
       FROM companies WHERE id = $1`,
      [companyId]
    ).then((r) => r.rows[0]);
    if (!companyRow) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Company not found' } });
    }

    const behavior = await chatbotBehaviorRepository.get(companyId);
    const chatbot_configured = !!(behavior && behavior.agent_name && String(behavior.agent_name).trim());

    const leadCount = await pool.query(
      'SELECT COUNT(*)::int AS n FROM leads WHERE company_id = $1',
      [companyId]
    ).then((r) => r.rows[0]?.n ?? 0);

    const steps = {
      company_info: !!(companyRow.name && String(companyRow.name).trim()),
      chatbot_configured,
      manychat_connected: companyRow.manychat_connected === true,
      mode_selected: companyRow.operating_mode != null && String(companyRow.operating_mode).trim() !== '',
      first_lead: leadCount > 0,
    };
    const current_step = [
      steps.company_info,
      steps.chatbot_configured,
      steps.manychat_connected,
      steps.mode_selected,
      steps.first_lead,
    ].filter(Boolean).length;
    const completed = companyRow.onboarding_completed === true;

    return res.json({
      completed,
      current_step: Math.max(1, current_step),
      steps,
    });
  } catch (err) {
    logger.error('[onboarding] status:', err.message);
    return errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.post('/complete', async (req, res) => {
  try {
    const companyId = req.tenantId;
    await pool.query(
      'UPDATE companies SET onboarding_completed = true WHERE id = $1',
      [companyId]
    );
    return res.json({ success: true, completed: true });
  } catch (err) {
    logger.error('[onboarding] complete:', err.message);
    return errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

module.exports = router;
