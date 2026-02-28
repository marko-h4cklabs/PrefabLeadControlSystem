/**
 * Co-Pilot API routes — active DMs, stats, and conversation management for
 * the appointment setter workflow.
 */

const logger = require('../../lib/logger');
const express = require('express');
const router = express.Router();
const { pool } = require('../../../db');
const { errorJson } = require('../middleware/errors');
const { requireRole } = require('../middleware/auth');
const { chatbotBehaviorRepository, chatbotCompanyInfoRepository, chatbotQuoteFieldsRepository } = require('../../../db/repositories');
const { sendSuggestion } = require('../../../services/replySuggestionsService');

/**
 * GET /api/copilot/active-dms
 * Returns conversations where the last message is from the user (awaiting response).
 * Used by the Co-Pilot workspace left panel.
 */
router.get('/active-dms', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { sort = 'recent', limit = 50, filter = 'all' } = req.query;

    let orderBy = 'c.last_message_at DESC NULLS LAST';
    if (sort === 'score') orderBy = 'l.score DESC NULLS LAST, c.last_message_at DESC NULLS LAST';
    if (sort === 'waiting') orderBy = 'c.last_message_at ASC NULLS LAST';

    let filterClause = '';
    const params = [companyId];
    if (filter === 'mine') {
      filterClause = ' AND l.assigned_to = $3';
      params.push(Math.min(Number(limit) || 50, 100));
      params.push(req.user.id);
    } else if (filter === 'unassigned') {
      filterClause = ' AND l.assigned_to IS NULL';
      params.push(Math.min(Number(limit) || 50, 100));
    } else {
      params.push(Math.min(Number(limit) || 50, 100));
    }

    const result = await pool.query(
      `SELECT
         l.id AS lead_id,
         l.name AS lead_name,
         l.external_id,
         l.score,
         l.channel,
         l.pipeline_stage,
         l.assigned_to,
         u.full_name AS assigned_to_name,
         c.id AS conversation_id,
         c.last_message_at,
         c.status AS conversation_status,
         (SELECT text FROM chat_messages WHERE lead_id = l.id ORDER BY created_at DESC LIMIT 1) AS last_message_preview,
         (SELECT role FROM chat_messages WHERE lead_id = l.id ORDER BY created_at DESC LIMIT 1) AS last_message_role,
         (SELECT COUNT(*)::int FROM reply_suggestions rs WHERE rs.lead_id = l.id AND rs.used_at IS NULL) AS pending_suggestions
       FROM leads l
       JOIN conversations c ON c.lead_id = l.id
       LEFT JOIN users u ON u.id = l.assigned_to
       WHERE l.company_id = $1
         AND c.status != 'closed'
         ${filterClause}
       ORDER BY ${orderBy}
       LIMIT $2`,
      params
    );

    const dms = result.rows.map((r) => ({
      lead_id: r.lead_id,
      lead_name: r.lead_name || 'Unknown',
      external_id: r.external_id,
      score: r.score ?? 0,
      channel: r.channel || 'instagram',
      pipeline_stage: r.pipeline_stage || 'new',
      assigned_to: r.assigned_to || null,
      assigned_to_name: r.assigned_to_name || null,
      profile_pic: null,
      conversation_id: r.conversation_id,
      last_message_at: r.last_message_at,
      last_message_preview: r.last_message_preview
        ? r.last_message_preview.substring(0, 120)
        : '',
      last_message_role: r.last_message_role || 'user',
      needs_response: r.last_message_role === 'user',
      has_suggestions: (r.pending_suggestions || 0) > 0,
    }));

    res.json({ dms });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * GET /api/copilot/stats
 * Dashboard metrics for the Co-Pilot view.
 */
router.get('/stats', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // Active conversations (not closed)
    const activeResult = await pool.query(
      `SELECT COUNT(*)::int AS count FROM conversations c
       JOIN leads l ON l.id = c.lead_id
       WHERE l.company_id = $1 AND c.status != 'closed'`,
      [companyId]
    );

    // Handled today (suggestions used today)
    const handledResult = await pool.query(
      `SELECT COUNT(DISTINCT rs.lead_id)::int AS count FROM reply_suggestions rs
       JOIN leads l ON l.id = rs.lead_id
       WHERE l.company_id = $1 AND rs.used_at >= $2`,
      [companyId, todayStart.toISOString()]
    );

    // Average response time (seconds) — average time between user message and next assistant message, last 7 days
    const avgResponseResult = await pool.query(
      `SELECT COALESCE(AVG(response_seconds), 0)::int AS avg_seconds FROM (
         SELECT EXTRACT(EPOCH FROM (
           (SELECT MIN(m2.created_at) FROM chat_messages m2
            WHERE m2.lead_id = m1.lead_id AND m2.role = 'assistant' AND m2.created_at > m1.created_at)
           - m1.created_at
         )) AS response_seconds
         FROM chat_messages m1
         JOIN leads l ON l.id = m1.lead_id
         WHERE l.company_id = $1 AND m1.role = 'user' AND m1.created_at >= NOW() - INTERVAL '7 days'
         LIMIT 200
       ) sub WHERE response_seconds > 0 AND response_seconds < 86400`,
      [companyId]
    );

    // Suggestion acceptance rate
    const suggestionsResult = await pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(used_at)::int AS used
       FROM reply_suggestions rs
       JOIN leads l ON l.id = rs.lead_id
       WHERE l.company_id = $1 AND rs.created_at >= NOW() - INTERVAL '7 days'`,
      [companyId]
    );

    // Leads qualified today (score >= 70 as proxy for qualified)
    const qualifiedResult = await pool.query(
      `SELECT COUNT(*)::int AS count FROM leads
       WHERE company_id = $1 AND score >= 70 AND updated_at >= $2`,
      [companyId, todayStart.toISOString()]
    );

    // Activity chart (last 7 days)
    const activityResult = await pool.query(
      `SELECT date_trunc('day', rs.used_at)::date AS date, COUNT(DISTINCT rs.lead_id)::int AS handled
       FROM reply_suggestions rs
       JOIN leads l ON l.id = rs.lead_id
       WHERE l.company_id = $1 AND rs.used_at >= NOW() - INTERVAL '7 days'
       GROUP BY 1 ORDER BY 1`,
      [companyId]
    );

    const sugTotal = suggestionsResult.rows[0]?.total || 0;
    const sugUsed = suggestionsResult.rows[0]?.used || 0;

    res.json({
      active_conversations: activeResult.rows[0]?.count || 0,
      handled_today: handledResult.rows[0]?.count || 0,
      avg_response_time_seconds: avgResponseResult.rows[0]?.avg_seconds || 0,
      suggestion_acceptance_rate: sugTotal > 0 ? Math.round((sugUsed / sugTotal) * 100) : 0,
      leads_qualified_today: qualifiedResult.rows[0]?.count || 0,
      activity_chart: activityResult.rows.map((r) => ({
        date: r.date,
        handled: r.handled,
      })),
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * PATCH /api/copilot/conversations/:id/dismiss
 * Mark a conversation as handled/dismissed without sending a reply.
 */
router.patch('/conversations/:id/dismiss', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { id } = req.params;

    const result = await pool.query(
      `UPDATE conversations SET status = 'dismissed', updated_at = NOW()
       WHERE id = $1 AND lead_id IN (SELECT id FROM leads WHERE company_id = $2)
       RETURNING id`,
      [id, companyId]
    );

    if (result.rowCount === 0) {
      return errorJson(res, 404, 'NOT_FOUND', 'Conversation not found');
    }

    res.json({ success: true });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ---------------------------------------------------------------------------
// Kill Switch
// ---------------------------------------------------------------------------

/**
 * GET /api/copilot/kill-switch
 * Returns whether the bot is enabled for this company.
 */
router.get('/kill-switch', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const result = await pool.query(
      `SELECT bot_enabled FROM companies WHERE id = $1`,
      [companyId]
    );
    if (result.rowCount === 0) {
      return errorJson(res, 404, 'NOT_FOUND', 'Company not found');
    }
    res.json({ enabled: !!result.rows[0].bot_enabled });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * PUT /api/copilot/kill-switch
 * Enable or disable the bot for this company. Requires owner or admin role.
 */
router.put('/kill-switch', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return errorJson(res, 400, 'INVALID_INPUT', 'enabled must be a boolean');
    }

    await pool.query(
      `UPDATE companies SET bot_enabled = $1, updated_at = NOW() WHERE id = $2`,
      [enabled, companyId]
    );

    logger.info(`Kill switch toggled to ${enabled} for company ${companyId}`);
    res.json({ enabled });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ---------------------------------------------------------------------------
// Lead Assignment
// ---------------------------------------------------------------------------

/**
 * PUT /api/copilot/leads/:leadId/assign
 * Assign or unassign a lead to a user.
 */
router.put('/leads/:leadId/assign', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { leadId } = req.params;
    const { user_id } = req.body;

    const result = await pool.query(
      `UPDATE leads
       SET assigned_to = $1,
           assigned_at = $2,
           updated_at = NOW()
       WHERE id = $3 AND company_id = $4
       RETURNING id`,
      [user_id || null, user_id ? new Date().toISOString() : null, leadId, companyId]
    );

    if (result.rowCount === 0) {
      return errorJson(res, 404, 'NOT_FOUND', 'Lead not found');
    }

    res.json({ success: true });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * POST /api/copilot/leads/bulk-assign
 * Assign multiple leads to a user (or unassign if user_id is null).
 */
router.post('/leads/bulk-assign', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { lead_ids, user_id } = req.body;

    if (!Array.isArray(lead_ids) || lead_ids.length === 0) {
      return errorJson(res, 400, 'INVALID_INPUT', 'lead_ids must be a non-empty array');
    }

    const result = await pool.query(
      `UPDATE leads
       SET assigned_to = $1,
           assigned_at = $2,
           updated_at = NOW()
       WHERE id = ANY($3::uuid[]) AND company_id = $4`,
      [user_id || null, user_id ? new Date().toISOString() : null, lead_ids, companyId]
    );

    res.json({ updated: result.rowCount });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ---------------------------------------------------------------------------
// Batch Operations
// ---------------------------------------------------------------------------

/**
 * POST /api/copilot/batch/send
 * Send selected suggestions for multiple conversations sequentially.
 */
router.post('/batch/send', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return errorJson(res, 400, 'INVALID_INPUT', 'items must be a non-empty array');
    }

    const results = [];
    for (let i = 0; i < items.length; i++) {
      const { conversation_id, suggestion_id, suggestion_index } = items[i];
      try {
        await sendSuggestion(suggestion_id, suggestion_index, companyId);
        results.push({ conversation_id, success: true });
      } catch (sendErr) {
        logger.error(`Batch send failed for conversation ${conversation_id}: ${sendErr.message}`);
        results.push({ conversation_id, success: false, error: sendErr.message });
      }

      // 100ms delay between sends (skip after last item)
      if (i < items.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    res.json({ results });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * POST /api/copilot/batch/dismiss
 * Dismiss multiple conversations at once.
 */
router.post('/batch/dismiss', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { conversation_ids } = req.body;

    if (!Array.isArray(conversation_ids) || conversation_ids.length === 0) {
      return errorJson(res, 400, 'INVALID_INPUT', 'conversation_ids must be a non-empty array');
    }

    const result = await pool.query(
      `UPDATE conversations SET status = 'dismissed', updated_at = NOW()
       WHERE id = ANY($1::uuid[])
         AND lead_id IN (SELECT id FROM leads WHERE company_id = $2)`,
      [conversation_ids, companyId]
    );

    res.json({ dismissed: result.rowCount });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ---------------------------------------------------------------------------
// Lead Summary
// ---------------------------------------------------------------------------

/**
 * GET /api/copilot/leads/:leadId/summary
 * Returns comprehensive lead summary with intelligence, activity, notes, and more.
 */
router.get('/leads/:leadId/summary', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { leadId } = req.params;

    // Lead info + assigned setter name
    const leadResult = await pool.query(
      `SELECT
         l.id, l.name, l.channel, l.score, l.pipeline_stage, l.created_at,
         l.assigned_to, l.intent_score, l.intent_tags, l.budget_detected,
         l.urgency_level, l.is_hot_lead, l.conversation_summary,
         u.full_name AS assigned_to_name
       FROM leads l
       LEFT JOIN users u ON u.id = l.assigned_to
       WHERE l.id = $1 AND l.company_id = $2`,
      [leadId, companyId]
    );

    if (leadResult.rowCount === 0) {
      return errorJson(res, 404, 'NOT_FOUND', 'Lead not found');
    }

    const lead = leadResult.rows[0];

    // Parsed fields from conversations
    const conversationResult = await pool.query(
      `SELECT parsed_fields FROM conversations WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [leadId]
    );

    // Recent activity (last 10)
    const activityResult = await pool.query(
      `SELECT * FROM lead_activities WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [leadId]
    );

    // Notes (last 5)
    const notesResult = await pool.query(
      `SELECT * FROM lead_notes WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 5`,
      [leadId]
    );

    // Pending suggestion count
    const suggestionsResult = await pool.query(
      `SELECT COUNT(*)::int AS count FROM reply_suggestions WHERE lead_id = $1 AND used_at IS NULL`,
      [leadId]
    );

    res.json({
      lead: {
        id: lead.id,
        name: lead.name,
        channel: lead.channel,
        score: lead.score,
        pipeline_stage: lead.pipeline_stage,
        created_at: lead.created_at,
        assigned_to: lead.assigned_to,
        assigned_to_name: lead.assigned_to_name,
      },
      intelligence: {
        intent_score: lead.intent_score,
        intent_tags: lead.intent_tags,
        budget_detected: lead.budget_detected,
        urgency_level: lead.urgency_level,
        is_hot_lead: lead.is_hot_lead,
        conversation_summary: lead.conversation_summary,
      },
      parsed_fields: conversationResult.rows[0]?.parsed_fields || null,
      recent_activity: activityResult.rows,
      notes: notesResult.rows,
      pending_suggestions: suggestionsResult.rows[0]?.count || 0,
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ---------------------------------------------------------------------------
// Copilot Settings (Mode-Scoped)
// ---------------------------------------------------------------------------

/**
 * GET /api/copilot/settings/behavior
 */
router.get('/settings/behavior', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const behavior = await chatbotBehaviorRepository.get(companyId, 'copilot');
    res.json(behavior || {});
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * PUT /api/copilot/settings/behavior
 */
router.put('/settings/behavior', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const result = await chatbotBehaviorRepository.upsert(companyId, req.body, 'copilot');
    res.json(result);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * GET /api/copilot/settings/identity
 */
router.get('/settings/identity', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const identity = await chatbotCompanyInfoRepository.get(companyId, 'copilot');
    res.json(identity || {});
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * PUT /api/copilot/settings/identity
 */
router.put('/settings/identity', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const result = await chatbotCompanyInfoRepository.upsert(companyId, req.body, 'copilot');
    res.json(result);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * GET /api/copilot/settings/fields
 */
router.get('/settings/fields', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const fields = await chatbotQuoteFieldsRepository.list(companyId, 'copilot');
    res.json(fields || []);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * PUT /api/copilot/settings/fields
 */
router.put('/settings/fields', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { presets } = req.body;

    if (!Array.isArray(presets)) {
      return errorJson(res, 400, 'INVALID_INPUT', 'presets must be an array');
    }

    const result = await chatbotQuoteFieldsRepository.updatePresets(companyId, presets, 'copilot');
    res.json(result);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * GET /api/copilot/settings/personas
 */
router.get('/settings/personas', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const result = await pool.query(
      `SELECT * FROM chatbot_personas
       WHERE company_id = $1 AND operating_mode = 'copilot'
       ORDER BY created_at DESC`,
      [companyId]
    );
    res.json(result.rows);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * POST /api/copilot/settings/personas
 */
router.post('/settings/personas', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { name, system_prompt, is_active } = req.body;

    const result = await pool.query(
      `INSERT INTO chatbot_personas (company_id, name, system_prompt, is_active, operating_mode, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'copilot', NOW(), NOW())
       RETURNING *`,
      [companyId, name, system_prompt, is_active || false]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * PUT /api/copilot/settings/personas/:id
 */
router.put('/settings/personas/:id', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { id } = req.params;
    const { name, system_prompt, is_active } = req.body;

    const result = await pool.query(
      `UPDATE chatbot_personas
       SET name = COALESCE($1, name),
           system_prompt = COALESCE($2, system_prompt),
           is_active = COALESCE($3, is_active),
           updated_at = NOW()
       WHERE id = $4 AND company_id = $5
       RETURNING *`,
      [name, system_prompt, is_active, id, companyId]
    );

    if (result.rowCount === 0) {
      return errorJson(res, 404, 'NOT_FOUND', 'Persona not found');
    }

    res.json(result.rows[0]);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * DELETE /api/copilot/settings/personas/:id
 * Only delete if the persona is not currently active.
 */
router.delete('/settings/personas/:id', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { id } = req.params;

    // Check if persona is active before deleting
    const check = await pool.query(
      `SELECT is_active FROM chatbot_personas WHERE id = $1 AND company_id = $2`,
      [id, companyId]
    );

    if (check.rowCount === 0) {
      return errorJson(res, 404, 'NOT_FOUND', 'Persona not found');
    }

    if (check.rows[0].is_active) {
      return errorJson(res, 400, 'PERSONA_ACTIVE', 'Cannot delete an active persona');
    }

    await pool.query(
      `DELETE FROM chatbot_personas WHERE id = $1 AND company_id = $2`,
      [id, companyId]
    );

    res.json({ success: true });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * POST /api/copilot/settings/personas/:id/activate
 * Activate a persona and deactivate all others for the copilot mode.
 */
router.post('/settings/personas/:id/activate', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { id } = req.params;

    // Deactivate all copilot personas for this company
    await pool.query(
      `UPDATE chatbot_personas SET is_active = false, updated_at = NOW()
       WHERE company_id = $1 AND operating_mode = 'copilot'`,
      [companyId]
    );

    // Activate the selected persona
    const result = await pool.query(
      `UPDATE chatbot_personas SET is_active = true, updated_at = NOW()
       WHERE id = $1 AND company_id = $2
       RETURNING *`,
      [id, companyId]
    );

    if (result.rowCount === 0) {
      return errorJson(res, 404, 'NOT_FOUND', 'Persona not found');
    }

    res.json(result.rows[0]);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ---------------------------------------------------------------------------
// Team & Performance
// ---------------------------------------------------------------------------

/**
 * GET /api/copilot/team
 * Returns team members with today's metrics.
 */
router.get('/team', async (req, res) => {
  try {
    const companyId = req.tenantId;

    const result = await pool.query(
      `SELECT
         u.id,
         u.full_name,
         u.email,
         u.role,
         COALESCE(sm.dms_handled, 0)::int AS dms_handled,
         COALESCE(sm.avg_response_seconds, 0)::int AS avg_response_seconds,
         COALESCE(sm.leads_qualified, 0)::int AS leads_qualified
       FROM users u
       LEFT JOIN setter_metrics sm ON sm.user_id = u.id AND sm.date = CURRENT_DATE
       WHERE u.company_id = $1
       ORDER BY u.full_name ASC`,
      [companyId]
    );

    res.json(result.rows);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * GET /api/copilot/team/:userId/performance
 * Detailed performance stats for a user over the last 7 days.
 */
router.get('/team/:userId/performance', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { userId } = req.params;

    // Verify user belongs to this company
    const userCheck = await pool.query(
      `SELECT id FROM users WHERE id = $1 AND company_id = $2`,
      [userId, companyId]
    );

    if (userCheck.rowCount === 0) {
      return errorJson(res, 404, 'NOT_FOUND', 'User not found');
    }

    const result = await pool.query(
      `SELECT * FROM setter_metrics
       WHERE user_id = $1 AND date >= NOW() - INTERVAL '7 days'
       ORDER BY date ASC`,
      [userId]
    );

    const daily = result.rows;
    const totals = daily.reduce(
      (acc, row) => {
        acc.dms_handled += Number(row.dms_handled) || 0;
        acc.suggestions_sent += Number(row.suggestions_sent) || 0;
        acc.suggestions_accepted += Number(row.suggestions_accepted) || 0;
        acc.leads_qualified += Number(row.leads_qualified) || 0;
        acc.avg_response_seconds_sum += Number(row.avg_response_seconds) || 0;
        acc.days += 1;
        return acc;
      },
      { dms_handled: 0, suggestions_sent: 0, suggestions_accepted: 0, leads_qualified: 0, avg_response_seconds_sum: 0, days: 0 }
    );

    res.json({
      daily,
      totals: {
        dms_handled: totals.dms_handled,
        suggestions_sent: totals.suggestions_sent,
        suggestions_accepted: totals.suggestions_accepted,
        leads_qualified: totals.leads_qualified,
        avg_response_seconds: totals.days > 0 ? Math.round(totals.avg_response_seconds_sum / totals.days) : 0,
      },
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

module.exports = router;
