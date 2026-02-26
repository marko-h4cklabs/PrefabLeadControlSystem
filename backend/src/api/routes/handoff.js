/**
 * Handoff Routes — Human-Break / Takeover System
 *
 * CRUD for handoff rules + pause/resume per-conversation bot control.
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../../../db');
const { conversationRepository } = require('../../../db/repositories');
const { errorJson } = require('../middleware/errors');
const { requireRole } = require('../middleware/auth');
const handoffService = require('../../services/handoffService');

// ── Rules CRUD ──────────────────────────────────────────────────

/**
 * GET /api/handoff/rules — list all handoff rules for company
 */
router.get('/rules', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM handoff_rules WHERE company_id = $1 ORDER BY priority ASC, created_at ASC',
      [req.tenantId]
    );
    res.json({ rules: result.rows });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * POST /api/handoff/rules — create a new handoff rule
 */
router.post('/rules', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { rule_type, trigger_value, action, bridging_message, priority } = req.body;
    if (!rule_type || !trigger_value) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'rule_type and trigger_value are required');
    }
    const validTypes = ['keyword', 'topic', 'sentiment', 'explicit_request', 'message_count', 'hot_lead'];
    if (!validTypes.includes(rule_type)) {
      return errorJson(res, 400, 'VALIDATION_ERROR', `rule_type must be one of: ${validTypes.join(', ')}`);
    }
    const result = await pool.query(
      `INSERT INTO handoff_rules (company_id, rule_type, trigger_value, action, bridging_message, priority)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.tenantId, rule_type, trigger_value, action || 'pause_and_notify', bridging_message || null, priority || 100]
    );
    res.status(201).json({ rule: result.rows[0] });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * PUT /api/handoff/rules/:id — update a handoff rule
 */
router.put('/rules/:id', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { rule_type, trigger_value, action, bridging_message, is_active, priority } = req.body;
    const result = await pool.query(
      `UPDATE handoff_rules
       SET rule_type = COALESCE($1, rule_type),
           trigger_value = COALESCE($2, trigger_value),
           action = COALESCE($3, action),
           bridging_message = $4,
           is_active = COALESCE($5, is_active),
           priority = COALESCE($6, priority)
       WHERE id = $7 AND company_id = $8
       RETURNING *`,
      [rule_type, trigger_value, action, bridging_message ?? null, is_active, priority, req.params.id, req.tenantId]
    );
    if (!result.rows[0]) return errorJson(res, 404, 'NOT_FOUND', 'Rule not found');
    res.json({ rule: result.rows[0] });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * DELETE /api/handoff/rules/:id — delete a handoff rule
 */
router.delete('/rules/:id', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM handoff_rules WHERE id = $1 AND company_id = $2 RETURNING id',
      [req.params.id, req.tenantId]
    );
    if (!result.rows[0]) return errorJson(res, 404, 'NOT_FOUND', 'Rule not found');
    res.json({ success: true });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ── Pause / Resume ──────────────────────────────────────────────

/**
 * POST /api/handoff/pause/:leadId — manually pause bot for a conversation
 */
router.post('/pause/:leadId', async (req, res) => {
  try {
    const { reason } = req.body;
    const conv = await conversationRepository.pauseBot(req.params.leadId, reason || 'Manual pause', 'manual');
    if (!conv) return errorJson(res, 404, 'NOT_FOUND', 'Conversation not found');

    // Log the manual pause
    await pool.query(
      `INSERT INTO handoff_log (conversation_id, company_id, lead_id, trigger_reason, paused_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [conv.id, req.tenantId, req.params.leadId, reason || 'Manual pause']
    ).catch(() => {});

    res.json({ success: true, paused: true });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * POST /api/handoff/resume/:leadId — resume bot for a conversation
 */
router.post('/resume/:leadId', async (req, res) => {
  try {
    const { instruction } = req.body;
    await handoffService.resumeHandoff(req.params.leadId, 'manual');
    const conv = await conversationRepository.getByLeadId(req.params.leadId);

    // If owner provided an instruction, add it as a system note for the bot
    if (instruction && conv) {
      await conversationRepository.appendMessage(req.params.leadId, 'system', `[Owner instruction: ${instruction}]`, {
        handoff_instruction: true,
      });
    }

    res.json({ success: true, paused: false });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * GET /api/handoff/status/:leadId — get handoff status for a conversation
 */
router.get('/status/:leadId', async (req, res) => {
  try {
    const status = await handoffService.getHandoffStatus(req.params.leadId);
    res.json(status);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ── Handoff Log ─────────────────────────────────────────────────

/**
 * GET /api/handoff/log — list handoff events for company
 */
router.get('/log', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const result = await pool.query(
      `SELECT h.*, l.name as lead_name
       FROM handoff_log h
       LEFT JOIN leads l ON l.id = h.lead_id
       WHERE h.company_id = $1
       ORDER BY h.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.tenantId, limit, offset]
    );
    res.json({ log: result.rows });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * GET /api/handoff/active — list all currently paused conversations
 */
router.get('/active', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.lead_id, c.paused_at, c.paused_reason, c.paused_by, l.name as lead_name
       FROM conversations c
       JOIN leads l ON l.id = c.lead_id
       WHERE l.company_id = $1 AND c.bot_paused = true
       ORDER BY c.paused_at DESC`,
      [req.tenantId]
    );
    res.json({ paused_conversations: result.rows });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ── Settings ────────────────────────────────────────────────────

/**
 * GET /api/handoff/settings — get handoff settings (auto-resume, bridging message)
 */
router.get('/settings', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT auto_resume_minutes, handoff_bridging_message FROM chatbot_behavior WHERE company_id = $1',
      [req.tenantId]
    );
    const settings = result.rows[0] || { auto_resume_minutes: 30, handoff_bridging_message: null };
    res.json(settings);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * PUT /api/handoff/settings — update handoff settings
 */
router.put('/settings', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { auto_resume_minutes, handoff_bridging_message } = req.body;
    await pool.query(
      `UPDATE chatbot_behavior
       SET auto_resume_minutes = COALESCE($1, auto_resume_minutes),
           handoff_bridging_message = $2
       WHERE company_id = $3`,
      [auto_resume_minutes, handoff_bridging_message ?? null, req.tenantId]
    );
    res.json({ success: true });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

module.exports = router;
