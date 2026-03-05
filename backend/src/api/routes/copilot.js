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
const { chatbotBehaviorRepository, chatbotCompanyInfoRepository, chatbotQuoteFieldsRepository, companyRepository } = require('../../../db/repositories');
const { sendSuggestion } = require('../../../services/replySuggestionsService');
const { publish: publishEvent } = require('../../lib/eventBus');

/**
 * GET /api/copilot/active-dms
 * Returns conversations where the last message is from the user (awaiting response).
 * Used by the Co-Pilot workspace left panel.
 */
router.get('/active-dms', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { sort = 'recent', limit = 50, filter = 'all', dm_status_filter } = req.query;
    const userRole = req.user.role;

    let orderBy = 'c.last_updated DESC NULLS LAST';
    if (sort === 'score') orderBy = 'l.score DESC NULLS LAST, c.last_updated DESC NULLS LAST';
    if (sort === 'waiting') orderBy = `CASE WHEN c.messages->-1->>'role' = 'user' THEN 0 ELSE 1 END ASC, c.last_updated ASC NULLS LAST`;
    if (sort === 'urgency') orderBy = `CASE WHEN c.messages->-1->>'role' = 'user' THEN EXTRACT(EPOCH FROM NOW() - c.last_updated) ELSE 0 END DESC, c.last_updated ASC`;

    const limitVal = Math.min(Number(limit) || 50, 100);

    let filterClause = '';
    const params = [companyId, limitVal];
    let paramIdx = 3;

    // Setter scoping: setters can only see Mine + Unassigned
    if (userRole === 'setter') {
      if (filter === 'mine') {
        filterClause += ` AND l.assigned_to = $${paramIdx}`;
        params.push(req.user.id);
        paramIdx++;
      } else {
        // Default for setter: mine + unassigned
        filterClause += ` AND (l.assigned_to = $${paramIdx} OR l.assigned_to IS NULL)`;
        params.push(req.user.id);
        paramIdx++;
      }
    } else {
      // Owner/admin: full filter options
      if (filter === 'mine') {
        filterClause += ` AND l.assigned_to = $${paramIdx}`;
        params.push(req.user.id);
        paramIdx++;
      } else if (filter === 'unassigned') {
        filterClause += ' AND l.assigned_to IS NULL';
      }
    }

    // DM status filter
    if (dm_status_filter && ['active', 'booked', 'lost', 'done'].includes(dm_status_filter)) {
      filterClause += ` AND COALESCE(l.dm_status, 'active') = $${paramIdx}`;
      params.push(dm_status_filter);
      paramIdx++;
    } else {
      // By default, only show active DMs (hide done/booked/lost)
      filterClause += ` AND COALESCE(l.dm_status, 'active') = 'active'`;
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
         COALESCE(l.dm_status, 'active') AS dm_status,
         l.dm_status_updated_at,
         u.full_name AS assigned_to_name,
         u.setter_status AS assigned_setter_status,
         c.id AS conversation_id,
         c.last_updated,
         c.messages->-1->>'content' AS last_message_preview,
         c.messages->-1->>'role' AS last_message_role,
         CASE
           WHEN c.messages->-1->>'role' = 'user'
           THEN EXTRACT(EPOCH FROM NOW() - c.last_updated)::int
           ELSE 0
         END AS waiting_seconds,
         (SELECT COUNT(*)::int FROM reply_suggestions rs WHERE rs.lead_id = l.id AND rs.used_at IS NULL) AS pending_suggestions
       FROM leads l
       JOIN conversations c ON c.lead_id = l.id
       LEFT JOIN users u ON u.id = l.assigned_to
       WHERE l.company_id = $1
         ${filterClause}
       ORDER BY ${orderBy}
       LIMIT $2`,
      params
    );

    const dms = result.rows.map((r) => {
      const waitingSec = r.waiting_seconds || 0;
      let urgency = 'none';
      if (r.last_message_role === 'user') {
        if (waitingSec > 900) urgency = 'critical';       // >15min
        else if (waitingSec > 300) urgency = 'warning';    // >5min
        else urgency = 'ok';                                // <5min
      }

      return {
        lead_id: r.lead_id,
        lead_name: r.lead_name || 'Unknown',
        external_id: r.external_id,
        score: r.score ?? 0,
        channel: r.channel || 'instagram',
        pipeline_stage: r.pipeline_stage || 'new',
        assigned_to: r.assigned_to || null,
        assigned_to_name: r.assigned_to_name || null,
        assigned_setter_status: r.assigned_setter_status || null,
        dm_status: r.dm_status || 'active',
        dm_status_updated_at: r.dm_status_updated_at || null,
        profile_pic: null,
        conversation_id: r.conversation_id,
        last_message_at: r.last_updated,
        last_message_preview: r.last_message_preview
          ? r.last_message_preview.substring(0, 120)
          : '',
        last_message_role: r.last_message_role || 'user',
        needs_response: r.last_message_role === 'user',
        has_suggestions: (r.pending_suggestions || 0) > 0,
        waiting_seconds: waitingSec,
        urgency,
      };
    });

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

    // Active conversations (leads with a conversation)
    const activeResult = await pool.query(
      `SELECT COUNT(*)::int AS count FROM conversations c
       JOIN leads l ON l.id = c.lead_id
       WHERE l.company_id = $1`,
      [companyId]
    );

    // Handled today (suggestions used today)
    const handledResult = await pool.query(
      `SELECT COUNT(DISTINCT rs.lead_id)::int AS count FROM reply_suggestions rs
       JOIN leads l ON l.id = rs.lead_id
       WHERE l.company_id = $1 AND rs.used_at >= $2`,
      [companyId, todayStart.toISOString()]
    );

    // Average response time from setter_metrics (today)
    let avgResponseResult;
    try {
      avgResponseResult = await pool.query(
        `SELECT COALESCE(AVG(NULLIF(avg_response_seconds, 0)), 0)::int AS avg_seconds
         FROM setter_metrics sm
         JOIN users u ON u.id = sm.user_id
         WHERE u.company_id = $1 AND sm.date = CURRENT_DATE`,
        [companyId]
      );
    } catch (_) {
      // setter_metrics table may not exist yet
      avgResponseResult = { rows: [{ avg_seconds: 0 }] };
    }

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
 * Mark pending suggestions as dismissed for this conversation.
 */
router.patch('/conversations/:id/dismiss', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { id } = req.params;

    // Mark all unused suggestions for this conversation as dismissed
    const result = await pool.query(
      `UPDATE reply_suggestions SET used_at = NOW(), used_suggestion_index = -1
       WHERE conversation_id = $1 AND used_at IS NULL
         AND company_id = $2
       RETURNING id`,
      [id, companyId]
    );

    res.json({ success: true, dismissed: result.rowCount });
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
    let enabled = true;
    try {
      const result = await pool.query(
        `SELECT bot_enabled FROM companies WHERE id = $1`,
        [companyId]
      );
      if (result.rowCount === 0) {
        return errorJson(res, 404, 'NOT_FOUND', 'Company not found');
      }
      enabled = result.rows[0].bot_enabled !== false;
    } catch (colErr) {
      // bot_enabled column may not exist yet — default to enabled
      if (colErr.message && colErr.message.includes('bot_enabled')) {
        enabled = true;
      } else {
        throw colErr;
      }
    }
    res.json({ enabled });
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

    try {
      await pool.query(
        `UPDATE companies SET bot_enabled = $1, updated_at = NOW() WHERE id = $2`,
        [enabled, companyId]
      );
    } catch (colErr) {
      if (colErr.message && colErr.message.includes('bot_enabled')) {
        // Column not yet added — silently succeed (bot is always on without the column)
        logger.warn(`Kill switch column bot_enabled not found, migration 070 pending`);
      } else {
        throw colErr;
      }
    }

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

    try {
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
    } catch (colErr) {
      if (colErr.message && (colErr.message.includes('assigned_to') || colErr.message.includes('assigned_at'))) {
        return errorJson(res, 501, 'NOT_IMPLEMENTED', 'Lead assignment requires migration 070. Please run database migrations.');
      }
      throw colErr;
    }

    publishEvent(companyId, {
      type: 'dm_assigned',
      leadId,
      assignedTo: user_id || null,
    }).catch(() => {});

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

    try {
      const result = await pool.query(
        `UPDATE leads
         SET assigned_to = $1,
             assigned_at = $2,
             updated_at = NOW()
         WHERE id = ANY($3::uuid[]) AND company_id = $4`,
        [user_id || null, user_id ? new Date().toISOString() : null, lead_ids, companyId]
      );
      // Emit SSE event for each affected lead
      for (const lid of lead_ids) {
        publishEvent(companyId, {
          type: 'dm_assigned',
          leadId: lid,
          assignedTo: user_id || null,
        }).catch(() => {});
      }

      res.json({ updated: result.rowCount });
    } catch (colErr) {
      if (colErr.message && (colErr.message.includes('assigned_to') || colErr.message.includes('assigned_at'))) {
        return errorJson(res, 501, 'NOT_IMPLEMENTED', 'Lead assignment requires migration 070. Please run database migrations.');
      }
      throw colErr;
    }
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
      `UPDATE reply_suggestions SET used_at = NOW(), used_suggestion_index = -1
       WHERE conversation_id = ANY($1::uuid[])
         AND used_at IS NULL
         AND company_id = $2`,
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

    // Lead info — try with extended columns, fall back to basic
    let lead;
    try {
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
      lead = leadResult.rows[0];
    } catch (colErr) {
      // Fallback: some columns may not exist yet
      const leadResult = await pool.query(
        `SELECT l.id, l.name, l.channel, l.score, l.pipeline_stage, l.created_at
         FROM leads l
         WHERE l.id = $1 AND l.company_id = $2`,
        [leadId, companyId]
      );
      if (leadResult.rowCount === 0) {
        return errorJson(res, 404, 'NOT_FOUND', 'Lead not found');
      }
      lead = leadResult.rows[0];
    }

    // Parsed fields from conversations
    const conversationResult = await pool.query(
      `SELECT parsed_fields FROM conversations WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [leadId]
    );

    // Recent activity (last 10) — table may not exist
    let activityRows = [];
    try {
      const activityResult = await pool.query(
        `SELECT * FROM lead_activities WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [leadId]
      );
      activityRows = activityResult.rows;
    } catch (_) { /* lead_activities table may not exist */ }

    // Notes (last 5) — table may not exist
    let notesRows = [];
    try {
      const notesResult = await pool.query(
        `SELECT * FROM lead_notes WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 5`,
        [leadId]
      );
      notesRows = notesResult.rows;
    } catch (_) { /* lead_notes table may not exist */ }

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
        assigned_to: lead.assigned_to || null,
        assigned_to_name: lead.assigned_to_name || null,
      },
      intelligence: {
        intent_score: lead.intent_score || null,
        intent_tags: lead.intent_tags || null,
        budget_detected: lead.budget_detected || null,
        urgency_level: lead.urgency_level || null,
        is_hot_lead: lead.is_hot_lead || false,
        conversation_summary: lead.conversation_summary || null,
      },
      parsed_fields: conversationResult.rows[0]?.parsed_fields || null,
      recent_activity: activityRows,
      notes: notesRows.map((r) => ({ id: r.id, content: r.body, created_at: r.created_at })),
      pending_suggestions: suggestionsResult.rows[0]?.count || 0,
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * DELETE /api/copilot/leads/:leadId
 * Permanently delete a lead and all related data (conversations, suggestions, etc.).
 * All child tables use ON DELETE CASCADE so a single DELETE suffices.
 */
router.delete('/leads/:leadId', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { leadId } = req.params;

    const result = await pool.query(
      'DELETE FROM leads WHERE id = $1 AND company_id = $2 RETURNING id, name',
      [leadId, companyId]
    );

    if (result.rowCount === 0) {
      return errorJson(res, 404, 'NOT_FOUND', 'Lead not found');
    }

    logger.info({ leadId, companyId }, '[copilot] Lead deleted');
    res.json({ success: true, deleted: result.rows[0] });
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
    // Sync behavior fields to active AI persona snapshot when AI mode is active
    const BEHAVIOR_PERSONA_KEYS = [
      'tone', 'response_length', 'emojis_enabled', 'opener_style',
      'human_error_enabled', 'human_error_types', 'human_error_random', 'no_trailing_period',
      'bot_deny_response',
    ];
    const syncFields = {};
    for (const key of BEHAVIOR_PERSONA_KEYS) {
      if (req.body[key] !== undefined) syncFields[key] = req.body[key];
    }
    if (Object.keys(syncFields).length > 0) {
      await pool.query(
        `UPDATE copilot_ai_personas p
         SET snapshot = snapshot || $1::jsonb, updated_at = NOW()
         FROM chatbot_behavior b
         WHERE b.company_id = $2
           AND b.copilot_persona_source = 'ai_generated'
           AND b.active_ai_persona_id = p.id`,
        [JSON.stringify(syncFields), companyId]
      ).catch(() => {});
    }
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
 * GET /api/copilot/settings/agent-identity
 * Full agent identity: name, backstory, business info — scoped to copilot mode.
 */
router.get('/settings/agent-identity', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const [behavior, companyRecord, companyInfo] = await Promise.all([
      chatbotBehaviorRepository.get(companyId, 'copilot').catch(() => null),
      companyRepository.findById(companyId).catch(() => null),
      chatbotCompanyInfoRepository.get(companyId, 'copilot').catch(() => null),
    ]);
    res.json({
      agent_name: behavior?.agent_name ?? '',
      agent_backstory: behavior?.agent_backstory ?? '',
      business_name: companyRecord?.name ?? '',
      business_description: companyInfo?.business_description ?? '',
      additional_context: companyInfo?.additional_notes ?? '',
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * PUT /api/copilot/settings/agent-identity
 */
router.put('/settings/agent-identity', requireRole('owner', 'admin', 'setter'), async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { agent_name, agent_backstory, business_name, business_description, additional_context } = req.body ?? {};
    await chatbotBehaviorRepository.upsert(companyId, {
      agent_name: agent_name ?? undefined,
      agent_backstory: agent_backstory ?? undefined,
    }, 'copilot');
    if (business_name !== undefined) {
      await pool.query(
        `UPDATE companies SET name = CASE WHEN $1::text IS NOT NULL THEN $1 ELSE name END WHERE id = $2`,
        [business_name, companyId]
      ).catch(() => {});
    }
    if (business_description !== undefined || additional_context !== undefined) {
      await chatbotCompanyInfoRepository.upsert(companyId, {
        business_description: business_description ?? undefined,
        additional_notes: additional_context ?? undefined,
      }, 'copilot');
    }
    // Sync to active AI persona snapshot when AI mode is active
    const fields = {};
    if (agent_name !== undefined) fields.agent_name = agent_name;
    if (agent_backstory !== undefined) fields.agent_backstory = agent_backstory;
    if (Object.keys(fields).length > 0) {
      await pool.query(
        `UPDATE copilot_ai_personas p
         SET snapshot = snapshot || $1::jsonb, updated_at = NOW()
         FROM chatbot_behavior b
         WHERE b.company_id = $2
           AND b.copilot_persona_source = 'ai_generated'
           AND b.active_ai_persona_id = p.id`,
        [JSON.stringify(fields), companyId]
      ).catch(() => {});
    }
    res.json({ success: true });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * GET /api/copilot/settings/strategy
 * Conversation strategy (goal, follow-up style, closing, etc.) — copilot mode.
 */
router.get('/settings/strategy', async (req, res) => {
  try {
    const behavior = await chatbotBehaviorRepository.get(req.tenantId, 'copilot');
    res.json({
      primary_goal: behavior?.conversation_goal ?? '',
      follow_up_style: behavior?.follow_up_style ?? 'gentle',
      closing_style: behavior?.closing_style ?? 'soft',
      competitor_mentions: behavior?.competitor_mentions ?? 'deflect',
      price_reveal: behavior?.price_reveal ?? 'ask_first',
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * PUT /api/copilot/settings/strategy
 */
router.put('/settings/strategy', requireRole('owner', 'admin', 'setter'), async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { primary_goal, follow_up_style, closing_style, competitor_mentions, price_reveal } = req.body ?? {};
    await chatbotBehaviorRepository.upsert(companyId, {
      conversation_goal: primary_goal ?? undefined,
      follow_up_style: follow_up_style ?? undefined,
      closing_style: closing_style ?? undefined,
      competitor_mentions: competitor_mentions ?? undefined,
      price_reveal: price_reveal ?? undefined,
    }, 'copilot');
    // Sync strategy fields to active AI persona snapshot when AI mode is active
    const syncFields = {};
    if (follow_up_style !== undefined) syncFields.follow_up_style = follow_up_style;
    if (closing_style !== undefined) syncFields.closing_style = closing_style;
    if (Object.keys(syncFields).length > 0) {
      await pool.query(
        `UPDATE copilot_ai_personas p
         SET snapshot = snapshot || $1::jsonb, updated_at = NOW()
         FROM chatbot_behavior b
         WHERE b.company_id = $2
           AND b.copilot_persona_source = 'ai_generated'
           AND b.active_ai_persona_id = p.id`,
        [JSON.stringify(syncFields), companyId]
      ).catch(() => {});
    }
    res.json({ success: true });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * GET /api/copilot/settings/guardrails
 * Guardrails (prohibited topics, bot denial, etc.) — copilot mode.
 */
router.get('/settings/guardrails', async (req, res) => {
  try {
    const behavior = await chatbotBehaviorRepository.get(req.tenantId, 'copilot');
    res.json({
      bot_deny_response: behavior?.bot_deny_response ?? '',
      prohibited_topics: behavior?.prohibited_topics ?? '',
      handoff_trigger: behavior?.handoff_trigger ?? '',
      human_fallback_message: behavior?.human_fallback_message ?? '',
      max_messages_before_handoff: behavior?.max_messages_before_handoff ?? 20,
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * PUT /api/copilot/settings/guardrails
 */
router.put('/settings/guardrails', requireRole('owner', 'admin', 'setter'), async (req, res) => {
  try {
    const { bot_deny_response, prohibited_topics, handoff_trigger, human_fallback_message, max_messages_before_handoff } = req.body ?? {};
    await chatbotBehaviorRepository.upsert(req.tenantId, {
      bot_deny_response: bot_deny_response ?? undefined,
      prohibited_topics: prohibited_topics ?? undefined,
      handoff_trigger: handoff_trigger ?? undefined,
      human_fallback_message: human_fallback_message ?? undefined,
      max_messages_before_handoff: max_messages_before_handoff ?? undefined,
    }, 'copilot');
    res.json({ success: true });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * GET /api/copilot/settings/social-proof
 * Social proof text/enabled — copilot mode. Images are company-wide (shared).
 */
router.get('/settings/social-proof', async (req, res) => {
  try {
    const behavior = await chatbotBehaviorRepository.get(req.tenantId, 'copilot');
    res.json({
      enabled: behavior?.social_proof_enabled ?? false,
      examples: behavior?.social_proof_examples ?? '',
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * PUT /api/copilot/settings/social-proof
 */
router.put('/settings/social-proof', requireRole('owner', 'admin', 'setter'), async (req, res) => {
  try {
    const { enabled, examples } = req.body ?? {};
    await chatbotBehaviorRepository.upsert(req.tenantId, {
      social_proof_enabled: enabled ?? undefined,
      social_proof_examples: examples ?? undefined,
    }, 'copilot');
    res.json({ success: true });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ---------------------------------------------------------------------------
// AI Persona Generator endpoints
// ---------------------------------------------------------------------------

const multer = require('multer');
// Accept text files + images (for vision analysis), 20 MB per file, 50 files per upload
const personaUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 50 } });

/**
 * GET /api/copilot/settings/persona-config
 * Returns current persona source + active AI persona metadata + list of all saved personas.
 */
router.get('/settings/persona-config', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const behavior = await chatbotBehaviorRepository.get(companyId, 'copilot');
    const personasResult = await pool.query(
      `SELECT id, name, style_summary, knowledge_base, snapshot, created_at, updated_at
       FROM copilot_ai_personas
       WHERE company_id = $1
       ORDER BY created_at DESC`,
      [companyId]
    );
    res.json({
      copilot_persona_source: behavior.copilot_persona_source || 'manual',
      active_ai_persona_id: behavior.active_ai_persona_id || null,
      active_ai_persona: behavior._active_ai_persona || null,
      personas: personasResult.rows,
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * PUT /api/copilot/settings/persona-source
 * Switch active persona source between 'manual' and 'ai_generated'.
 */
router.put('/settings/persona-source', requireRole('owner', 'admin', 'setter'), async (req, res) => {
  try {
    const { source } = req.body ?? {};
    if (!['manual', 'ai_generated'].includes(source)) {
      return res.status(400).json({ error: 'source must be "manual" or "ai_generated"' });
    }
    const behavior = await chatbotBehaviorRepository.get(req.tenantId, 'copilot');
    if (source === 'ai_generated' && !behavior.active_ai_persona_id) {
      return res.status(400).json({ error: 'No AI persona selected. Choose a persona first.' });
    }
    await chatbotBehaviorRepository.upsert(req.tenantId, { copilot_persona_source: source }, 'copilot');
    res.json({ success: true, copilot_persona_source: source });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * POST /api/copilot/settings/generate-persona
 * Upload files (.json, .txt, .docx, .xlsx) and/or images (screenshots).
 * AI analyzes them and returns a generated persona + knowledge_base.
 * Does NOT save — frontend presents preview for user to confirm.
 */
router.post('/settings/generate-persona', requireRole('owner', 'admin', 'setter'), personaUpload.array('files', 50), async (req, res) => {
  try {
    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'Upload at least one file (.json, .txt, .docx, .xlsx) or image screenshot.' });
    }

    // sender_name is optional — helps AI filter messages from the right person in group chats
    const senderName = (req.body?.sender_name || '').trim() || null;

    const { generatePersonaFromFiles } = require('../../../services/copilotPersonaGenerator');
    const result = await generatePersonaFromFiles(
      files.map((f) => ({ buffer: f.buffer, mimetype: f.mimetype, originalname: f.originalname })),
      senderName
    );

    res.json(result);
  } catch (err) {
    logger.error({ err: err.message }, '[copilot] generate-persona error');
    res.status(500).json({ error: err.message || 'Persona generation failed.' });
  }
});

/**
 * PUT /api/copilot/settings/ai-persona
 * Save the AI-generated persona snapshot and set it as active source.
 */
router.put('/settings/ai-persona', requireRole('owner', 'admin', 'setter'), async (req, res) => {
  try {
    const persona = req.body ?? {};
    const ALLOWED_KEYS = [
      'agent_name', 'agent_backstory', 'tone', 'response_length', 'emojis_enabled',
      'opener_style', 'conversation_approach', 'follow_up_style', 'closing_style',
      'human_error_enabled', 'human_error_types', 'human_error_random',
      'no_trailing_period', 'bot_deny_response',
    ];
    const snapshot = {};
    for (const key of ALLOWED_KEYS) {
      if (persona[key] !== undefined) snapshot[key] = persona[key];
    }
    if (Object.keys(snapshot).length === 0) {
      return res.status(400).json({ error: 'No persona fields provided.' });
    }
    await chatbotBehaviorRepository.upsert(req.tenantId, {
      ai_persona_snapshot: snapshot,
      ai_persona_generated_at: new Date().toISOString(),
      ai_persona_summary: persona.style_summary || null,
      copilot_persona_source: 'ai_generated',
    }, 'copilot');
    res.json({ success: true });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ─── Named AI Persona CRUD ──────────────────────────────────────────────────

/**
 * GET /api/copilot/settings/ai-personas
 * List all saved AI persona templates for this company.
 */
router.get('/settings/ai-personas', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, style_summary, knowledge_base, snapshot, created_at, updated_at
       FROM copilot_ai_personas
       WHERE company_id = $1
       ORDER BY created_at DESC`,
      [req.tenantId]
    );
    res.json(result.rows);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * POST /api/copilot/settings/ai-personas
 * Save a generated persona as a named template.
 * Body: { name, snapshot, style_summary, knowledge_base }
 */
router.post('/settings/ai-personas', requireRole('owner', 'admin', 'setter'), async (req, res) => {
  try {
    const { name, snapshot, style_summary, knowledge_base } = req.body ?? {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Persona name is required.' });
    }
    if (!snapshot || typeof snapshot !== 'object') {
      return res.status(400).json({ error: 'Persona snapshot is required.' });
    }
    const result = await pool.query(
      `INSERT INTO copilot_ai_personas (company_id, name, snapshot, style_summary, knowledge_base)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, style_summary, knowledge_base, snapshot, created_at, updated_at`,
      [req.tenantId, name.trim(), JSON.stringify(snapshot), style_summary || null, knowledge_base || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * PUT /api/copilot/settings/ai-personas/:id
 * Update a saved AI persona (name, snapshot fields, style_summary, knowledge_base).
 */
router.put('/settings/ai-personas/:id', requireRole('owner', 'admin', 'setter'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, snapshot, style_summary, knowledge_base } = req.body ?? {};

    // Verify ownership
    const check = await pool.query(
      `SELECT id, snapshot FROM copilot_ai_personas WHERE id = $1 AND company_id = $2`,
      [id, req.tenantId]
    );
    if (!check.rows[0]) return res.status(404).json({ error: 'Persona not found.' });

    const existing = check.rows[0];
    const mergedSnapshot = snapshot
      ? { ...existing.snapshot, ...snapshot }
      : existing.snapshot;

    const result = await pool.query(
      `UPDATE copilot_ai_personas
       SET name = COALESCE($3, name),
           snapshot = $4,
           style_summary = COALESCE($5, style_summary),
           knowledge_base = COALESCE($6, knowledge_base),
           updated_at = NOW()
       WHERE id = $1 AND company_id = $2
       RETURNING id, name, style_summary, knowledge_base, snapshot, created_at, updated_at`,
      // Only update knowledge_base when explicitly provided (not undefined) — prevents accidental wipes
      [id, req.tenantId, name ? name.trim() : null, JSON.stringify(mergedSnapshot), style_summary || null, knowledge_base !== undefined ? knowledge_base : null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * POST /api/copilot/settings/ai-personas/:id/upload-knowledge
 * Upload a document (.docx, .txt, .xlsx) and extract text for the knowledge base.
 * Returns extracted text — does NOT auto-save (frontend appends + user reviews).
 */
const knowledgeUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
router.post('/settings/ai-personas/:id/upload-knowledge', requireRole('owner', 'admin', 'setter'), (req, res, next) => {
  knowledgeUpload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File too large (max 10MB).' });
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    next();
  });
}, async (req, res) => {
  try {
    const { id } = req.params;
    // Verify ownership
    const check = await pool.query(
      'SELECT id FROM copilot_ai_personas WHERE id = $1 AND company_id = $2',
      [id, req.tenantId]
    );
    if (!check.rows[0]) return errorJson(res, 404, 'NOT_FOUND', 'Persona not found');

    if (!req.file) return errorJson(res, 400, 'VALIDATION_ERROR', 'No file uploaded');

    const { buffer, mimetype, originalname } = req.file;
    const ext = (originalname || '').split('.').pop()?.toLowerCase();

    let text = '';
    if (ext === 'txt' || mimetype === 'text/plain') {
      text = buffer.toString('utf-8').trim();
    } else if (ext === 'docx' || ext === 'xlsx' || ext === 'xls') {
      const { parseDocument } = require('../../services/documentParser');
      text = await parseDocument(buffer, mimetype, originalname);
    } else {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'Unsupported file type. Use .docx, .txt, or .xlsx');
    }

    if (!text.trim()) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'No text content found in file');
    }

    res.json({ text: text.trim().slice(0, 50000) });
  } catch (err) {
    logger.error({ err: err.message }, '[copilot/upload-knowledge] Error');
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * DELETE /api/copilot/settings/ai-personas/:id
 * Delete a saved AI persona. If it was active, clears active_ai_persona_id.
 */
router.delete('/settings/ai-personas/:id', requireRole('owner', 'admin', 'setter'), async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `DELETE FROM copilot_ai_personas WHERE id = $1 AND company_id = $2 RETURNING id`,
      [id, req.tenantId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Persona not found.' });
    // If this was the active persona, clear it and revert to manual
    await pool.query(
      `UPDATE chatbot_behavior
       SET active_ai_persona_id = NULL,
           copilot_persona_source = CASE WHEN active_ai_persona_id = $1 THEN 'manual' ELSE copilot_persona_source END
       WHERE company_id = $2`,
      [id, req.tenantId]
    );
    res.json({ success: true });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * PUT /api/copilot/settings/ai-personas/:id/activate
 * Set a saved AI persona as active and switch source to 'ai_generated'.
 */
router.put('/settings/ai-personas/:id/activate', requireRole('owner', 'admin', 'setter'), async (req, res) => {
  try {
    const { id } = req.params;
    const check = await pool.query(
      `SELECT id FROM copilot_ai_personas WHERE id = $1 AND company_id = $2`,
      [id, req.tenantId]
    );
    if (!check.rows[0]) return res.status(404).json({ error: 'Persona not found.' });

    await chatbotBehaviorRepository.upsert(req.tenantId, {
      active_ai_persona_id: id,
      copilot_persona_source: 'ai_generated',
    }, 'copilot');
    res.json({ success: true, active_ai_persona_id: id, copilot_persona_source: 'ai_generated' });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/copilot/settings/fields
 * Returns copilot-mode custom fields for this company.
 */
router.get('/settings/fields', async (req, res) => {
  try {
    const companyId = req.tenantId;
    let result;
    try {
      result = await pool.query(
        `SELECT id, name, label, type, field_type, priority, is_enabled, qualification_prompt, qualification_requirement
         FROM chatbot_quote_fields
         WHERE company_id = $1 AND is_custom = true AND COALESCE(operating_mode, 'autopilot') = 'copilot'
         ORDER BY priority ASC, name ASC`,
        [companyId]
      );
    } catch (colErr) {
      if (colErr.message && colErr.message.includes('operating_mode')) {
        result = await pool.query(
          `SELECT id, name, label, type, field_type, priority, is_enabled, qualification_prompt, qualification_requirement
           FROM chatbot_quote_fields
           WHERE company_id = $1 AND is_custom = true
           ORDER BY priority ASC, name ASC`,
          [companyId]
        );
      } else {
        throw colErr;
      }
    }
    const fields = (result.rows || []).map((f) => ({
      id: f.id,
      name: f.name,
      label: f.label || f.name,
      type: f.field_type || f.type || 'text',
      is_enabled: f.is_enabled !== false,
      qualification_prompt: f.qualification_prompt || '',
      qualification_requirement: f.qualification_requirement || '',
    }));
    res.json(fields);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * PUT /api/copilot/settings/fields
 * Accepts { presets: [...] } where each item is { name, type, is_enabled, qualification_prompt }.
 * Replaces all copilot-mode quote fields for this company.
 */
router.put('/settings/fields', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const fields = req.body.presets || req.body.fields || (Array.isArray(req.body) ? req.body : null);

    if (!Array.isArray(fields)) {
      return errorJson(res, 400, 'INVALID_INPUT', 'presets must be an array');
    }

    // Delete existing copilot-mode fields for this company, then recreate
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Remove existing copilot-mode fields
      try {
        await client.query(
          `DELETE FROM chatbot_quote_fields WHERE company_id = $1 AND COALESCE(operating_mode, 'autopilot') = 'copilot'`,
          [companyId]
        );
      } catch (colErr) {
        if (colErr.message && colErr.message.includes('operating_mode')) {
          await client.query(
            `DELETE FROM chatbot_quote_fields WHERE company_id = $1`,
            [companyId]
          );
        } else {
          throw colErr;
        }
      }

      // Re-insert each field
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        const name = (f.name || f.label || '').trim();
        if (!name) continue;
        const fieldType = (f.type || 'text').toLowerCase();
        const priority = i + 1;
        const isEnabled = f.is_enabled !== false;
        const qualPrompt = (f.qualification_prompt || '').trim() || null;
        const qualReq = (f.qualification_requirement || '').trim() || null;

        try {
          await client.query(
            `INSERT INTO chatbot_quote_fields (company_id, operating_mode, name, label, type, field_type, priority, required, is_enabled, config, is_custom, qualification_prompt, qualification_requirement)
             VALUES ($1, 'copilot', $2, $3, $4, $5, $6, true, $7, '{}'::jsonb, true, $8, $9)`,
            [companyId, name, name, fieldType, fieldType, priority, isEnabled, qualPrompt, qualReq]
          );
        } catch (colErr) {
          if (colErr.message && colErr.message.includes('operating_mode')) {
            await client.query(
              `INSERT INTO chatbot_quote_fields (company_id, name, label, type, field_type, priority, required, is_enabled, config, is_custom, qualification_prompt, qualification_requirement)
               VALUES ($1, $2, $3, $4, $5, $6, true, $7, '{}'::jsonb, true, $8, $9)`,
              [companyId, name, name, fieldType, fieldType, priority, isEnabled, qualPrompt, qualReq]
            );
          } else {
            throw colErr;
          }
        }
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    // Return the saved fields
    const saved = fields.filter((f) => (f.name || f.label || '').trim()).map((f, i) => ({
      id: f.id || null,
      name: (f.name || f.label || '').trim(),
      type: (f.type || 'text').toLowerCase(),
      is_enabled: f.is_enabled !== false,
      qualification_prompt: (f.qualification_prompt || '').trim(),
      qualification_requirement: (f.qualification_requirement || '').trim(),
    }));
    res.json(saved);
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
    let result;
    try {
      result = await pool.query(
        `SELECT * FROM chatbot_personas
         WHERE company_id = $1 AND operating_mode = 'copilot'
         ORDER BY created_at DESC`,
        [companyId]
      );
    } catch (colErr) {
      if (colErr.message && colErr.message.includes('operating_mode')) {
        // operating_mode column not added yet — return empty list
        result = { rows: [] };
      } else {
        throw colErr;
      }
    }
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

    let result;
    try {
      result = await pool.query(
        `INSERT INTO chatbot_personas (company_id, name, system_prompt, is_active, operating_mode, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'copilot', NOW(), NOW())
         RETURNING *`,
        [companyId, name, system_prompt, is_active || false]
      );
    } catch (colErr) {
      if (colErr.message && colErr.message.includes('operating_mode')) {
        result = await pool.query(
          `INSERT INTO chatbot_personas (company_id, name, system_prompt, is_active, created_at, updated_at)
           VALUES ($1, $2, $3, $4, NOW(), NOW())
           RETURNING *`,
          [companyId, name, system_prompt, is_active || false]
        );
      } else {
        throw colErr;
      }
    }

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
    try {
      await pool.query(
        `UPDATE chatbot_personas SET is_active = false, updated_at = NOW()
         WHERE company_id = $1 AND operating_mode = 'copilot'`,
        [companyId]
      );
    } catch (colErr) {
      if (colErr.message && colErr.message.includes('operating_mode')) {
        await pool.query(
          `UPDATE chatbot_personas SET is_active = false, updated_at = NOW()
           WHERE company_id = $1`,
          [companyId]
        );
      } else {
        throw colErr;
      }
    }

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

    let result;
    try {
      result = await pool.query(
        `SELECT
           u.id,
           u.full_name,
           u.email,
           u.role,
           u.setter_status,
           u.account_type,
           u.max_concurrent_dms,
           u.created_at,
           COALESCE(sm.dms_handled, 0)::int AS dms_handled,
           COALESCE(sm.avg_response_seconds, 0)::int AS avg_response_seconds,
           COALESCE(sm.leads_qualified, 0)::int AS leads_qualified,
           (SELECT COUNT(*)::int FROM leads lx WHERE lx.assigned_to = u.id AND lx.company_id = $1 AND COALESCE(lx.dm_status, 'active') = 'active') AS active_dms
         FROM users u
         LEFT JOIN setter_metrics sm ON sm.user_id = u.id AND sm.date = CURRENT_DATE
         WHERE u.company_id = $1
         ORDER BY u.full_name ASC`,
        [companyId]
      );
    } catch (tableErr) {
      result = await pool.query(
        `SELECT id, full_name, email, role, setter_status, account_type, max_concurrent_dms, created_at,
           0 AS dms_handled, 0 AS avg_response_seconds, 0 AS leads_qualified, 0 AS active_dms
         FROM users
         WHERE company_id = $1
         ORDER BY full_name ASC`,
        [companyId]
      );
    }

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

    let daily = [];
    try {
      const result = await pool.query(
        `SELECT * FROM setter_metrics
         WHERE user_id = $1 AND date >= NOW() - INTERVAL '7 days'
         ORDER BY date ASC`,
        [userId]
      );
      daily = result.rows;
    } catch (_) {
      // setter_metrics table may not exist yet
    }

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

// ---------------------------------------------------------------------------
// Team Invites
// ---------------------------------------------------------------------------

const crypto = require('crypto');

/**
 * POST /api/copilot/team/invite
 * Create an invite code for a team member.
 */
router.post('/team/invite', requireRole('admin'), async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { role = 'setter', max_uses = null, expires_days = 7 } = req.body || {};

    if (!['setter', 'admin'].includes(role)) {
      return errorJson(res, 400, 'INVALID_INPUT', 'role must be setter or admin');
    }

    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    const expiresAt = new Date(Date.now() + (Number(expires_days) || 7) * 24 * 60 * 60 * 1000);

    const result = await pool.query(
      `INSERT INTO team_invites (company_id, code, role, created_by, expires_at, max_uses)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [companyId, code, role, req.user.id, expiresAt, max_uses]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * GET /api/copilot/team/invites
 * List active invites for this company.
 */
router.get('/team/invites', requireRole('admin'), async (req, res) => {
  try {
    const companyId = req.tenantId;
    const result = await pool.query(
      `SELECT ti.*, u.full_name AS created_by_name
       FROM team_invites ti
       LEFT JOIN users u ON u.id = ti.created_by
       WHERE ti.company_id = $1
       ORDER BY ti.created_at DESC`,
      [companyId]
    );
    res.json(result.rows);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * DELETE /api/copilot/team/invites/:id
 * Revoke (deactivate) an invite.
 */
router.delete('/team/invites/:id', requireRole('admin'), async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { id } = req.params;
    const result = await pool.query(
      `UPDATE team_invites SET is_active = false
       WHERE id = $1 AND company_id = $2
       RETURNING id`,
      [id, companyId]
    );
    if (result.rowCount === 0) {
      return errorJson(res, 404, 'NOT_FOUND', 'Invite not found');
    }
    res.json({ success: true });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * DELETE /api/copilot/team/:userId
 * Remove a team member. Owner-only.
 */
router.delete('/team/:userId', requireRole('owner'), async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { userId } = req.params;

    if (userId === req.user.id) {
      return errorJson(res, 400, 'INVALID_INPUT', 'Cannot remove yourself');
    }

    const result = await pool.query(
      `DELETE FROM users WHERE id = $1 AND company_id = $2 AND account_type = 'team_member'
       RETURNING id`,
      [userId, companyId]
    );
    if (result.rowCount === 0) {
      return errorJson(res, 404, 'NOT_FOUND', 'Team member not found');
    }

    // Unassign their leads
    await pool.query(
      `UPDATE leads SET assigned_to = NULL, assigned_at = NULL WHERE assigned_to = $1 AND company_id = $2`,
      [userId, companyId]
    );

    res.json({ success: true });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ---------------------------------------------------------------------------
// Setter Availability
// ---------------------------------------------------------------------------

/**
 * GET /api/copilot/me/status
 * Get own setter status.
 */
router.get('/me/status', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT setter_status, setter_status_updated_at, max_concurrent_dms FROM users WHERE id = $1`,
      [req.user.id]
    );
    const row = result.rows[0];
    res.json({
      setter_status: row?.setter_status || 'offline',
      setter_status_updated_at: row?.setter_status_updated_at || null,
      max_concurrent_dms: row?.max_concurrent_dms || 20,
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * PUT /api/copilot/me/status
 * Set own status (active/away/offline).
 */
router.put('/me/status', async (req, res) => {
  try {
    const { setter_status } = req.body || {};
    if (!['active', 'away', 'offline'].includes(setter_status)) {
      return errorJson(res, 400, 'INVALID_INPUT', 'setter_status must be active, away, or offline');
    }

    await pool.query(
      `UPDATE users SET setter_status = $1, setter_status_updated_at = NOW() WHERE id = $2`,
      [setter_status, req.user.id]
    );

    res.json({ setter_status });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ---------------------------------------------------------------------------
// DM Disposition
// ---------------------------------------------------------------------------

/**
 * PUT /api/copilot/leads/:leadId/dm-status
 * Set the DM disposition (active/booked/lost/done).
 */
router.put('/leads/:leadId/dm-status', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { leadId } = req.params;
    const { dm_status } = req.body || {};

    if (!['active', 'booked', 'lost', 'done'].includes(dm_status)) {
      return errorJson(res, 400, 'INVALID_INPUT', 'dm_status must be active, booked, lost, or done');
    }

    const result = await pool.query(
      `UPDATE leads
       SET dm_status = $1,
           dm_status_updated_at = NOW(),
           dm_status_updated_by = $2,
           updated_at = NOW()
       WHERE id = $3 AND company_id = $4
       RETURNING id`,
      [dm_status, req.user.id, leadId, companyId]
    );

    if (result.rowCount === 0) {
      return errorJson(res, 404, 'NOT_FOUND', 'Lead not found');
    }

    // If booked, increment setter_metrics.leads_qualified
    if (dm_status === 'booked') {
      try {
        await pool.query(
          `INSERT INTO setter_metrics (user_id, date, leads_qualified)
           VALUES ($1, CURRENT_DATE, 1)
           ON CONFLICT (user_id, date)
           DO UPDATE SET leads_qualified = setter_metrics.leads_qualified + 1`,
          [req.user.id]
        );
      } catch { /* setter_metrics may not exist yet */ }
    }

    // Emit SSE event so other connected clients see the status change
    publishEvent(companyId, {
      type: 'lead_updated',
      leadId,
      dm_status,
      updatedBy: req.user.id,
    }).catch(() => {});

    res.json({ success: true, dm_status });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ---------------------------------------------------------------------------
// Assignment Configuration
// ---------------------------------------------------------------------------

/**
 * GET /api/copilot/settings/assignment
 * Get the company's assignment configuration.
 */
router.get('/settings/assignment', requireRole('admin'), async (req, res) => {
  try {
    const companyId = req.tenantId;
    const result = await pool.query(
      `SELECT assignment_mode, default_max_concurrent_dms FROM companies WHERE id = $1`,
      [companyId]
    );
    const row = result.rows[0] || {};
    res.json({
      assignment_mode: row.assignment_mode || 'manual',
      default_max_concurrent_dms: row.default_max_concurrent_dms || 20,
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * PUT /api/copilot/settings/assignment
 * Update assignment configuration.
 */
router.put('/settings/assignment', requireRole('admin'), async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { assignment_mode, default_max_concurrent_dms } = req.body || {};

    if (assignment_mode && !['manual', 'round_robin'].includes(assignment_mode)) {
      return errorJson(res, 400, 'INVALID_INPUT', 'assignment_mode must be manual or round_robin');
    }

    const updates = [];
    const values = [];
    let idx = 1;

    if (assignment_mode) {
      updates.push(`assignment_mode = $${idx}`);
      values.push(assignment_mode);
      idx++;
    }
    if (default_max_concurrent_dms !== undefined) {
      updates.push(`default_max_concurrent_dms = $${idx}`);
      values.push(Math.max(1, Math.min(100, Number(default_max_concurrent_dms) || 20)));
      idx++;
    }

    if (updates.length === 0) {
      return errorJson(res, 400, 'INVALID_INPUT', 'No fields to update');
    }

    values.push(companyId);
    await pool.query(
      `UPDATE companies SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${idx}`,
      values
    );

    res.json({ success: true });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * PUT /api/copilot/team/:userId/capacity
 * Set per-setter max concurrent DMs.
 */
router.put('/team/:userId/capacity', requireRole('admin'), async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { userId } = req.params;
    const { max_concurrent_dms } = req.body || {};

    const cap = Math.max(1, Math.min(100, Number(max_concurrent_dms) || 20));

    const result = await pool.query(
      `UPDATE users SET max_concurrent_dms = $1 WHERE id = $2 AND company_id = $3 RETURNING id`,
      [cap, userId, companyId]
    );

    if (result.rowCount === 0) {
      return errorJson(res, 404, 'NOT_FOUND', 'User not found');
    }

    res.json({ success: true, max_concurrent_dms: cap });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ────────────────────────────────────────────────────────────
// Calendly Booking URL (no API token — just a shareable booking link)
// ────────────────────────────────────────────────────────────

/**
 * PUT /api/copilot/settings/calendly-url
 * Save a manual Calendly booking link (no API token needed).
 */
router.put('/settings/calendly-url', requireRole('owner', 'admin', 'setter'), async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { calendly_url } = req.body || {};
    const url = (calendly_url || '').trim() || null;

    const { chatbotBehaviorRepository } = require('../../../db/repositories');
    await chatbotBehaviorRepository.upsert(companyId, {
      calendly_url: url,
      booking_trigger_enabled: !!url,
    }, 'copilot').catch(() => {});

    // Also store on companies table as fallback
    await pool.query(
      'UPDATE companies SET calendly_url = $1 WHERE id = $2',
      [url, companyId]
    ).catch(() => {});

    res.json({ success: true, calendly_url: url });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * GET /api/copilot/settings/calendly-url
 * Get the current booking URL.
 */
router.get('/settings/calendly-url', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { chatbotBehaviorRepository } = require('../../../db/repositories');
    const behavior = await chatbotBehaviorRepository.get(companyId, 'copilot');
    const calendlyUrl = behavior?.calendly_url || null;

    // Fallback to companies table
    let url = calendlyUrl;
    if (!url) {
      const compRow = await pool.query(
        'SELECT calendly_url, calendly_scheduling_url FROM companies WHERE id = $1',
        [companyId]
      ).catch(() => null);
      url = compRow?.rows?.[0]?.calendly_url || compRow?.rows?.[0]?.calendly_scheduling_url || null;
    }

    res.json({ calendly_url: url || '' });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ===========================================================================
// NOTIFICATION CHANNELS
// ===========================================================================

/**
 * GET /api/copilot/me/notification-channels
 * Returns the current user's notification channel configuration.
 */
router.get('/me/notification-channels', async (req, res) => {
  try {
    const userId = req.user.id;
    const { rows } = await pool.query(
      `SELECT id, channel_type, channel_config, enabled, created_at
       FROM notification_channels
       WHERE user_id = $1
       ORDER BY channel_type`,
      [userId]
    );
    res.json({ channels: rows });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * PUT /api/copilot/me/notification-channels/:channelType
 * Upsert a notification channel for the current user.
 * Body: { enabled, channel_config }
 */
router.put('/me/notification-channels/:channelType', async (req, res) => {
  try {
    const userId = req.user.id;
    const channelType = req.params.channelType;
    const validTypes = ['slack', 'telegram', 'browser'];
    if (!validTypes.includes(channelType)) {
      return errorJson(res, 400, 'INVALID_CHANNEL', `Invalid channel type. Must be one of: ${validTypes.join(', ')}`);
    }

    const { enabled = true, channel_config = {} } = req.body;

    const { rows } = await pool.query(
      `INSERT INTO notification_channels (user_id, channel_type, channel_config, enabled)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, channel_type) DO UPDATE SET
         channel_config = EXCLUDED.channel_config,
         enabled = EXCLUDED.enabled
       RETURNING id, channel_type, channel_config, enabled`,
      [userId, channelType, JSON.stringify(channel_config), enabled]
    );

    res.json(rows[0]);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * DELETE /api/copilot/me/notification-channels/:channelType
 * Remove a notification channel for the current user.
 */
router.delete('/me/notification-channels/:channelType', async (req, res) => {
  try {
    const userId = req.user.id;
    const channelType = req.params.channelType;
    await pool.query(
      `DELETE FROM notification_channels WHERE user_id = $1 AND channel_type = $2`,
      [userId, channelType]
    );
    res.json({ success: true });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

/**
 * POST /api/copilot/me/notification-channels/test
 * Send a test notification through a specific channel.
 * Body: { channel_type, channel_config }
 */
router.post('/me/notification-channels/test', async (req, res) => {
  try {
    const { channel_type, channel_config = {} } = req.body;
    if (!channel_type) {
      return errorJson(res, 400, 'MISSING_CHANNEL', 'channel_type is required');
    }

    const { dispatch } = require('../../../services/notificationDispatcher');

    // Temporarily create/update the channel, send test, then rely on actual save
    const title = 'Test Notification';
    const message = `This is a test notification from your copilot app. Channel: ${channel_type}`;

    if (channel_type === 'slack') {
      const webhookUrl = channel_config.webhook_url;
      if (!webhookUrl) return errorJson(res, 400, 'MISSING_CONFIG', 'webhook_url is required for Slack');

      const payload = {
        text: `*${title}*\n${message}`,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*${title}*\n${message}` } }],
      };
      const slackRes = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!slackRes.ok) return errorJson(res, 400, 'SLACK_ERROR', `Slack returned ${slackRes.status}`);
    } else if (channel_type === 'telegram') {
      const { bot_token, chat_id } = channel_config;
      if (!bot_token || !chat_id) return errorJson(res, 400, 'MISSING_CONFIG', 'bot_token and chat_id are required for Telegram');

      const tgRes = await fetch(`https://api.telegram.org/bot${bot_token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id, text: `${title}\n${message}`, parse_mode: 'HTML' }),
      });
      if (!tgRes.ok) {
        const body = await tgRes.text().catch(() => '');
        return errorJson(res, 400, 'TELEGRAM_ERROR', `Telegram returned ${tgRes.status}: ${body}`);
      }
    } else if (channel_type === 'browser') {
      // Browser push is client-side; just acknowledge
    }

    res.json({ success: true, message: 'Test notification sent' });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ─── Copilot Template Messages ───────────────────────────────────────────────

/**
 * GET /api/copilot/settings/templates
 * List all copilot template messages for the company.
 */
router.get('/settings/templates', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const r = await pool.query(
      `SELECT id, name, category, content, variables, use_count, created_at
       FROM message_templates
       WHERE company_id = $1 AND COALESCE(operating_mode, 'autopilot') = 'copilot'
       ORDER BY created_at ASC`,
      [companyId]
    );
    res.json({ templates: r.rows });
  } catch (err) {
    logger.error('[copilot/templates] list:', err.message);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to list templates');
  }
});

/**
 * POST /api/copilot/settings/templates
 * Create a new copilot template message.
 */
router.post('/settings/templates', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { name, content, category } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'name is required');
    }
    if (!content || typeof content !== 'string' || !content.trim()) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'content is required');
    }
    const variables = [];
    const matches = content.match(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g) || [];
    for (const m of [...new Set(matches.map(v => v.slice(1, -1)))]) variables.push(m);

    const r = await pool.query(
      `INSERT INTO message_templates (company_id, name, category, content, variables, operating_mode)
       VALUES ($1, $2, $3, $4, $5, 'copilot')
       RETURNING id, name, category, content, variables, use_count, created_at`,
      [companyId, name.trim(), (category && String(category).trim()) || 'general', content.trim(), variables]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    logger.error('[copilot/templates] create:', err.message);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to create template');
  }
});

/**
 * PUT /api/copilot/settings/templates/:id
 * Update a copilot template message.
 */
router.put('/settings/templates/:id', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { id } = req.params;
    const { name, content, category } = req.body || {};

    const sets = [];
    const vals = [id, companyId];
    let idx = 3;
    if (name && typeof name === 'string') { sets.push(`name = $${idx++}`); vals.push(name.trim()); }
    if (content && typeof content === 'string') {
      sets.push(`content = $${idx++}`);
      vals.push(content.trim());
      const variables = [];
      const matches = content.match(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g) || [];
      for (const m of [...new Set(matches.map(v => v.slice(1, -1)))]) variables.push(m);
      sets.push(`variables = $${idx++}`);
      vals.push(variables);
    }
    if (category && typeof category === 'string') { sets.push(`category = $${idx++}`); vals.push(category.trim()); }

    if (sets.length === 0) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'No fields to update');
    }

    const r = await pool.query(
      `UPDATE message_templates SET ${sets.join(', ')}
       WHERE id = $1 AND company_id = $2 AND COALESCE(operating_mode, 'autopilot') = 'copilot'
       RETURNING id, name, category, content, variables, use_count, created_at`,
      vals
    );
    if (!r.rows[0]) return errorJson(res, 404, 'NOT_FOUND', 'Template not found');
    res.json(r.rows[0]);
  } catch (err) {
    logger.error('[copilot/templates] update:', err.message);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to update template');
  }
});

/**
 * DELETE /api/copilot/settings/templates/:id
 * Delete a copilot template message.
 */
router.delete('/settings/templates/:id', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { id } = req.params;
    const r = await pool.query(
      `DELETE FROM message_templates WHERE id = $1 AND company_id = $2 AND COALESCE(operating_mode, 'autopilot') = 'copilot' RETURNING id`,
      [id, companyId]
    );
    if (!r.rows[0]) return errorJson(res, 404, 'NOT_FOUND', 'Template not found');
    res.json({ success: true });
  } catch (err) {
    logger.error('[copilot/templates] delete:', err.message);
    errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to delete template');
  }
});

// ---------------------------------------------------------------------------
// Voice note generation (ElevenLabs TTS preview)
// ---------------------------------------------------------------------------
const { isElevenLabsConfigured, textToSpeechWav, humanizeTextForTTS } = require('../../utils/elevenLabsClient');

/**
 * POST /api/copilot/voice/generate
 * Generate a voice note from text using the company's ElevenLabs voice settings.
 */
router.post('/voice/generate', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { text, ambient_noise, ambient_level, humanize } = req.body || {};

    if (!text || typeof text !== 'string' || !text.trim()) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'text is required');
    }
    if (text.trim().length > 5000) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'Text too long (max 5000 characters)');
    }
    if (!isElevenLabsConfigured()) {
      return errorJson(res, 503, 'SERVICE_UNAVAILABLE', 'ElevenLabs API key not configured');
    }

    // Query voice fields directly (companyRepository.findById strips them)
    const companyRow = await pool.query(
      'SELECT voice_selected_id, voice_model, voice_stability, voice_similarity_boost, voice_style, voice_speaker_boost, voice_style_prompt, voice_speed, voice_ambient_noise, voice_ambient_level FROM companies WHERE id = $1',
      [companyId]
    );
    const company = companyRow.rows[0];
    if (!company) return errorJson(res, 404, 'NOT_FOUND', 'Company not found');
    if (!company.voice_selected_id) {
      return errorJson(res, 400, 'VOICE_NOT_CONFIGURED', 'No voice selected. Configure a voice in Copilot Settings > Voice Messages.');
    }

    // Humanize text if requested (adds filler words for natural speech)
    let finalText = text.trim();
    if (humanize !== false) {
      finalText = await humanizeTextForTTS(finalText, company.voice_style_prompt || null);
    }

    // Per-message overrides fall back to company defaults
    const effectiveNoise = ambient_noise !== undefined ? ambient_noise : (company.voice_ambient_noise || null);
    const effectiveLevel = ambient_level !== undefined ? ambient_level : (parseInt(company.voice_ambient_level) || 5);

    const ttsResult = await textToSpeechWav(company.voice_selected_id, finalText, {
      model: company.voice_model || 'eleven_turbo_v2_5',
      stability: parseFloat(company.voice_stability) || 0.5,
      similarity_boost: parseFloat(company.voice_similarity_boost) || 0.75,
      style: parseFloat(company.voice_style) || 0,
      speaker_boost: company.voice_speaker_boost !== false,
      speed: parseFloat(company.voice_speed) || 1.0,
      ambientNoise: effectiveNoise,
      ambientLevel: effectiveLevel,
    });

    res.json({
      audio_base64: ttsResult.audio_base64,
      content_type: ttsResult.content_type,
    });
  } catch (err) {
    logger.error({ err: err.message }, '[copilot/voice/generate] Error');
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ---------------------------------------------------------------------------
// Company Knowledge Base
// ---------------------------------------------------------------------------
const { parseDocument } = require('../../services/documentParser');
const companyKbUpload = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

router.get('/settings/knowledge', async (req, res) => {
  try {
    const result = await pool.query('SELECT knowledge_base FROM companies WHERE id = $1', [req.tenantId]);
    res.json({ knowledge_base: result.rows[0]?.knowledge_base || '' });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.put('/settings/knowledge', async (req, res) => {
  try {
    const { knowledge_base } = req.body || {};
    if (typeof knowledge_base !== 'string') {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'knowledge_base must be a string');
    }
    await pool.query('UPDATE companies SET knowledge_base = $1 WHERE id = $2', [knowledge_base, req.tenantId]);
    res.json({ success: true });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.post('/settings/knowledge/upload', (req, res, next) => {
  companyKbUpload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return errorJson(res, 400, 'FILE_TOO_LARGE', 'File too large. Maximum 10MB.');
      return errorJson(res, 400, 'UPLOAD_ERROR', err.message || 'File upload failed');
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return errorJson(res, 400, 'VALIDATION_ERROR', 'No file uploaded');
    const ext = (req.file.originalname || '').split('.').pop()?.toLowerCase();
    let text;
    if (ext === 'txt') {
      text = req.file.buffer.toString('utf-8').trim();
    } else {
      text = await parseDocument(req.file.buffer, req.file.mimetype, req.file.originalname);
    }
    if (!text) return errorJson(res, 400, 'PARSE_ERROR', 'Could not extract text from file');
    res.json({ text });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

module.exports = router;
