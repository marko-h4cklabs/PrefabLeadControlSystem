/**
 * Co-Pilot API routes — active DMs, stats, and conversation management for
 * the appointment setter workflow.
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../../../db');
const { errorJson } = require('../middleware/errors');

/**
 * GET /api/copilot/active-dms
 * Returns conversations where the last message is from the user (awaiting response).
 * Used by the Co-Pilot workspace left panel.
 */
router.get('/active-dms', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { sort = 'recent', limit = 50 } = req.query;

    let orderBy = 'c.last_message_at DESC NULLS LAST';
    if (sort === 'score') orderBy = 'l.score DESC NULLS LAST, c.last_message_at DESC NULLS LAST';
    if (sort === 'waiting') orderBy = 'c.last_message_at ASC NULLS LAST';

    const result = await pool.query(
      `SELECT
         l.id AS lead_id,
         l.name AS lead_name,
         l.external_id,
         l.score,
         l.channel,
         l.pipeline_stage,
         c.id AS conversation_id,
         c.last_message_at,
         c.status AS conversation_status,
         (SELECT text FROM chat_messages WHERE lead_id = l.id ORDER BY created_at DESC LIMIT 1) AS last_message_preview,
         (SELECT role FROM chat_messages WHERE lead_id = l.id ORDER BY created_at DESC LIMIT 1) AS last_message_role,
         (SELECT COUNT(*)::int FROM reply_suggestions rs WHERE rs.lead_id = l.id AND rs.used_at IS NULL) AS pending_suggestions
       FROM leads l
       JOIN conversations c ON c.lead_id = l.id
       WHERE l.company_id = $1
         AND c.status != 'closed'
       ORDER BY ${orderBy}
       LIMIT $2`,
      [companyId, Math.min(Number(limit) || 50, 100)]
    );

    const dms = result.rows.map((r) => ({
      lead_id: r.lead_id,
      lead_name: r.lead_name || 'Unknown',
      external_id: r.external_id,
      score: r.score ?? 0,
      channel: r.channel || 'instagram',
      pipeline_stage: r.pipeline_stage || 'new',
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

module.exports = router;
