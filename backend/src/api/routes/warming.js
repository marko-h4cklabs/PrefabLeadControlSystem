/**
 * Warming sequences and enrollments API. All routes are tenant-scoped.
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../../../db');
const warmingService = require('../../services/warmingService');
const { errorJson } = require('../middleware/errors');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/warming/sequences — all sequences for company with steps
router.get('/sequences', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const seqs = await pool.query(
      `SELECT id, company_id, name, trigger_event, is_active, created_at,
              no_reply_delay_hours, max_follow_ups, escalation_action, escalation_value, category
       FROM warming_sequences WHERE company_id = $1 ORDER BY name`,
      [companyId]
    );
    const stepsBySeq = await pool.query(
      `SELECT id, sequence_id, step_order, delay_minutes, message_template, step_type, conditions, ai_context_prompt, created_at
       FROM warming_steps WHERE sequence_id = ANY($1::uuid[]) ORDER BY sequence_id, step_order`,
      [seqs.rows.map((s) => s.id)]
    );
    const stepsMap = {};
    for (const st of stepsBySeq.rows || []) {
      if (!stepsMap[st.sequence_id]) stepsMap[st.sequence_id] = [];
      stepsMap[st.sequence_id].push({
        id: st.id,
        step_order: st.step_order,
        delay_minutes: st.delay_minutes,
        message_template: st.message_template,
        step_type: st.step_type,
        conditions: st.conditions,
        ai_context_prompt: st.ai_context_prompt,
        created_at: st.created_at,
      });
    }
    const data = (seqs.rows || []).map((s) => ({
      id: s.id,
      company_id: s.company_id,
      name: s.name,
      trigger_event: s.trigger_event,
      is_active: Boolean(s.is_active),
      no_reply_delay_hours: s.no_reply_delay_hours ?? 72,
      max_follow_ups: s.max_follow_ups ?? 5,
      escalation_action: s.escalation_action,
      escalation_value: s.escalation_value,
      category: s.category ?? 'general',
      created_at: s.created_at,
      steps: (stepsMap[s.id] || []).sort((a, b) => a.step_order - b.step_order),
    }));
    res.json({ data });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// POST /api/warming/sequences — create sequence with steps (body: { name, trigger_event, steps: [{ delay_minutes, message_template, step_type? }] })
router.post('/sequences', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { name, trigger_event, steps, no_reply_delay_hours, max_follow_ups, escalation_action, escalation_value, category } = req.body || {};
    if (!name || !trigger_event || !Array.isArray(steps) || steps.length === 0) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'name, trigger_event, and steps (non-empty array) required');
    }
    const seq = await pool.query(
      `INSERT INTO warming_sequences (company_id, name, trigger_event, is_active, no_reply_delay_hours, max_follow_ups, escalation_action, escalation_value, category)
       VALUES ($1, $2, $3, true, $4, $5, $6, $7, $8)
       RETURNING id, name, trigger_event, is_active, no_reply_delay_hours, max_follow_ups, escalation_action, escalation_value, category, created_at`,
      [companyId, String(name).trim(), String(trigger_event).trim(),
       no_reply_delay_hours != null ? parseInt(no_reply_delay_hours, 10) : 72,
       max_follow_ups != null ? parseInt(max_follow_ups, 10) : 5,
       escalation_action ? String(escalation_action).substring(0, 30) : null,
       escalation_value ? String(escalation_value) : null,
       category ? String(category).substring(0, 30) : 'general']
    );
    const seqId = seq.rows[0].id;
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      await pool.query(
        `INSERT INTO warming_steps (sequence_id, step_order, delay_minutes, message_template, step_type, conditions, ai_context_prompt)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [seqId, i + 1, Math.max(0, parseInt(st.delay_minutes, 10) || 0), String(st.message_template || '').trim(),
         (st.step_type || 'message').substring(0, 30),
         st.conditions ? JSON.stringify(st.conditions) : null,
         st.ai_context_prompt ? String(st.ai_context_prompt) : null]
      );
    }
    const stepsOut = await pool.query(
      `SELECT id, step_order, delay_minutes, message_template, step_type FROM warming_steps WHERE sequence_id = $1 ORDER BY step_order`,
      [seqId]
    );
    res.status(201).json({
      id: seqId,
      name: seq.rows[0].name,
      trigger_event: seq.rows[0].trigger_event,
      is_active: true,
      created_at: seq.rows[0].created_at,
      steps: stepsOut.rows,
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// PUT /api/warming/sequences/:id — update name and is_active
router.put('/sequences/:id', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const id = req.params.id;
    if (!id || !UUID_REGEX.test(id)) return errorJson(res, 400, 'VALIDATION_ERROR', 'Valid sequence ID required');
    const { name, is_active, no_reply_delay_hours, max_follow_ups, escalation_action, escalation_value, category } = req.body || {};
    const updates = [];
    const params = [id, companyId];
    let idx = 3;
    if (name !== undefined) {
      updates.push(`name = $${idx++}`);
      params.push(String(name).trim());
    }
    if (is_active !== undefined) {
      updates.push(`is_active = $${idx++}`);
      params.push(!!is_active);
    }
    if (no_reply_delay_hours !== undefined) {
      updates.push(`no_reply_delay_hours = $${idx++}`);
      params.push(parseInt(no_reply_delay_hours, 10) || 72);
    }
    if (max_follow_ups !== undefined) {
      updates.push(`max_follow_ups = $${idx++}`);
      params.push(parseInt(max_follow_ups, 10) || 5);
    }
    if (escalation_action !== undefined) {
      updates.push(`escalation_action = $${idx++}`);
      params.push(escalation_action ? String(escalation_action).substring(0, 30) : null);
    }
    if (escalation_value !== undefined) {
      updates.push(`escalation_value = $${idx++}`);
      params.push(escalation_value ? String(escalation_value) : null);
    }
    if (category !== undefined) {
      updates.push(`category = $${idx++}`);
      params.push(String(category).substring(0, 30));
    }
    if (updates.length === 0) {
      const r = await pool.query(
        'SELECT id, name, trigger_event, is_active, created_at FROM warming_sequences WHERE id = $1 AND company_id = $2',
        [id, companyId]
      );
      if (!r.rows[0]) return errorJson(res, 404, 'NOT_FOUND', 'Sequence not found');
      return res.json(r.rows[0]);
    }
    const r = await pool.query(
      `UPDATE warming_sequences SET ${updates.join(', ')} WHERE id = $1 AND company_id = $2 RETURNING id, name, trigger_event, is_active, created_at`,
      params
    );
    if (!r.rows[0]) return errorJson(res, 404, 'NOT_FOUND', 'Sequence not found');
    res.json(r.rows[0]);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// DELETE /api/warming/sequences/:id — soft delete (set is_active = false)
router.delete('/sequences/:id', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const id = req.params.id;
    if (!id || !UUID_REGEX.test(id)) return errorJson(res, 400, 'VALIDATION_ERROR', 'Valid sequence ID required');
    const r = await pool.query(
      `UPDATE warming_sequences SET is_active = false WHERE id = $1 AND company_id = $2 RETURNING id`,
      [id, companyId]
    );
    if (!r.rows[0]) return errorJson(res, 404, 'NOT_FOUND', 'Sequence not found');
    res.json({ deleted: true, id });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// GET /api/warming/enrollments — enrollments with lead/sequence info + new tracking fields
router.get('/enrollments', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const statusFilter = req.query.status || 'active';
    const rows = await pool.query(
      `SELECT e.id, e.lead_id, e.sequence_id, e.enrolled_at, e.current_step, e.status,
              e.follow_ups_sent, e.paused, e.escalated, e.escalation_action, e.next_send_at,
              l.name AS lead_name, s.name AS sequence_name
       FROM warming_enrollments e
       JOIN leads l ON l.id = e.lead_id
       JOIN warming_sequences s ON s.id = e.sequence_id
       WHERE e.company_id = $1 AND e.status = $2
       ORDER BY e.enrolled_at DESC`,
      [companyId, statusFilter]
    );
    const data = (rows.rows || []).map((r) => ({
      id: r.id,
      lead_id: r.lead_id,
      sequence_id: r.sequence_id,
      lead_name: r.lead_name ?? null,
      sequence_name: r.sequence_name ?? null,
      current_step: parseInt(r.current_step, 10) || 0,
      follow_ups_sent: r.follow_ups_sent || 0,
      paused: Boolean(r.paused),
      escalated: Boolean(r.escalated),
      escalation_action: r.escalation_action,
      next_send_at: r.next_send_at,
      enrolled_at: r.enrolled_at,
      status: r.status,
    }));
    res.json({ data });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// POST /api/warming/enroll — body { lead_id, sequence_id }
router.post('/enroll', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { lead_id: leadId, sequence_id: sequenceId } = req.body || {};
    if (!leadId || !UUID_REGEX.test(leadId)) return errorJson(res, 400, 'VALIDATION_ERROR', 'lead_id (UUID) required');
    if (!sequenceId || !UUID_REGEX.test(sequenceId)) return errorJson(res, 400, 'VALIDATION_ERROR', 'sequence_id (UUID) required');
    const seq = await pool.query(
      'SELECT id, trigger_event FROM warming_sequences WHERE id = $1 AND company_id = $2 AND is_active = true',
      [sequenceId, companyId]
    );
    if (!seq.rows[0]) return errorJson(res, 404, 'NOT_FOUND', 'Sequence not found');
    const lead = await pool.query('SELECT id FROM leads WHERE id = $1 AND company_id = $2', [leadId, companyId]);
    if (!lead.rows[0]) return errorJson(res, 404, 'NOT_FOUND', 'Lead not found');
    const enrollmentId = await warmingService.enrollLeadInSequence(leadId, companyId, sequenceId);
    if (!enrollmentId) return errorJson(res, 500, 'INTERNAL_ERROR', 'Enrollment failed (no steps?)');
    res.status(201).json({ enrolled: true, lead_id: leadId, sequence_id: sequenceId, enrollment_id: enrollmentId });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// POST /api/warming/enrollments/:id/cancel
router.post('/enrollments/:id/cancel', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const id = req.params.id;
    if (!id || !UUID_REGEX.test(id)) return errorJson(res, 400, 'VALIDATION_ERROR', 'Valid enrollment ID required');
    const r = await pool.query(
      `UPDATE warming_enrollments SET status = 'cancelled', cancelled_at = NOW()
       WHERE id = $1 AND company_id = $2 AND status = 'active' RETURNING id`,
      [id, companyId]
    );
    if (!r.rows[0]) return errorJson(res, 404, 'NOT_FOUND', 'Enrollment not found or already cancelled');
    res.json({ cancelled: true, id });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ──────────────────────────────────────────────
// Follow-up Dashboard endpoints
// ──────────────────────────────────────────────

// GET /api/warming/dashboard — overview stats
router.get('/dashboard', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const stats = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE e.status = 'active' AND NOT COALESCE(e.paused, false)) AS active_count,
         COUNT(*) FILTER (WHERE COALESCE(e.paused, false) = true AND e.status = 'active') AS paused_count,
         COUNT(*) FILTER (WHERE e.status = 'completed') AS completed_count,
         COUNT(*) FILTER (WHERE COALESCE(e.escalated, false) = true) AS escalated_count,
         COALESCE(SUM(e.follow_ups_sent), 0) AS total_messages_sent
       FROM warming_enrollments e WHERE e.company_id = $1`,
      [companyId]
    );
    const replyStats = await pool.query(
      `SELECT
         COUNT(*) AS total_messages,
         COUNT(*) FILTER (WHERE lead_replied = true) AS replies,
         COUNT(*) FILTER (WHERE reply_sentiment = 'positive') AS positive_replies,
         COUNT(*) FILTER (WHERE reply_sentiment = 'negative') AS negative_replies
       FROM warming_message_log m
       JOIN warming_enrollments e ON e.id = m.enrollment_id
       WHERE e.company_id = $1`,
      [companyId]
    );
    const s = stats.rows[0] || {};
    const r = replyStats.rows[0] || {};
    const totalMsg = parseInt(r.total_messages, 10) || 0;
    const replies = parseInt(r.replies, 10) || 0;
    res.json({
      active_enrollments: parseInt(s.active_count, 10) || 0,
      paused_enrollments: parseInt(s.paused_count, 10) || 0,
      completed_enrollments: parseInt(s.completed_count, 10) || 0,
      escalated_count: parseInt(s.escalated_count, 10) || 0,
      total_messages_sent: parseInt(s.total_messages_sent, 10) || 0,
      reply_rate: totalMsg > 0 ? Math.round((replies / totalMsg) * 100) : 0,
      positive_replies: parseInt(r.positive_replies, 10) || 0,
      negative_replies: parseInt(r.negative_replies, 10) || 0,
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// GET /api/warming/dashboard/upcoming — next scheduled messages
router.get('/dashboard/upcoming', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const rows = await pool.query(
      `SELECT e.id AS enrollment_id, e.lead_id, e.next_send_at, e.current_step, e.follow_ups_sent,
              l.name AS lead_name, s.name AS sequence_name, s.id AS sequence_id,
              ws.message_template, ws.step_type
       FROM warming_enrollments e
       JOIN leads l ON l.id = e.lead_id
       JOIN warming_sequences s ON s.id = e.sequence_id
       LEFT JOIN warming_steps ws ON ws.sequence_id = s.id AND ws.step_order = e.current_step
       WHERE e.company_id = $1 AND e.status = 'active' AND COALESCE(e.paused, false) = false
       ORDER BY e.next_send_at ASC NULLS LAST
       LIMIT $2`,
      [companyId, limit]
    );
    res.json({ data: rows.rows });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// GET /api/warming/dashboard/timeline/:leadId — per-lead follow-up history
router.get('/dashboard/timeline/:leadId', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const leadId = req.params.leadId;
    if (!leadId || !UUID_REGEX.test(leadId)) return errorJson(res, 400, 'VALIDATION_ERROR', 'Valid lead ID required');
    const messages = await pool.query(
      `SELECT m.id, m.enrollment_id, m.step_id, m.message_sent, m.sent_at,
              m.lead_replied, m.reply_sentiment, m.replied_at,
              ws.step_order, ws.step_type, s.name AS sequence_name
       FROM warming_message_log m
       JOIN warming_enrollments e ON e.id = m.enrollment_id
       JOIN warming_sequences s ON s.id = e.sequence_id
       LEFT JOIN warming_steps ws ON ws.id = m.step_id
       WHERE m.lead_id = $1 AND e.company_id = $2
       ORDER BY m.sent_at DESC`,
      [leadId, companyId]
    );
    const enrollments = await pool.query(
      `SELECT e.id, e.sequence_id, e.status, e.enrolled_at, e.current_step,
              e.follow_ups_sent, e.paused, e.escalated, e.escalation_action,
              s.name AS sequence_name
       FROM warming_enrollments e
       JOIN warming_sequences s ON s.id = e.sequence_id
       WHERE e.lead_id = $1 AND e.company_id = $2
       ORDER BY e.enrolled_at DESC`,
      [leadId, companyId]
    );
    res.json({ messages: messages.rows, enrollments: enrollments.rows });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// GET /api/warming/dashboard/stats — per-sequence performance stats
router.get('/dashboard/stats', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const rows = await pool.query(
      `SELECT s.id AS sequence_id, s.name AS sequence_name,
              COUNT(DISTINCT e.id) AS total_enrollments,
              COUNT(DISTINCT e.id) FILTER (WHERE e.status = 'active') AS active_enrollments,
              COUNT(DISTINCT e.id) FILTER (WHERE e.status = 'completed') AS completed_enrollments,
              COALESCE(SUM(e.follow_ups_sent), 0) AS total_messages,
              COUNT(m.id) FILTER (WHERE m.lead_replied = true) AS total_replies,
              COUNT(m.id) FILTER (WHERE m.reply_sentiment = 'positive') AS positive_replies,
              COUNT(m.id) FILTER (WHERE m.reply_sentiment = 'negative') AS negative_replies
       FROM warming_sequences s
       LEFT JOIN warming_enrollments e ON e.sequence_id = s.id
       LEFT JOIN warming_message_log m ON m.enrollment_id = e.id
       WHERE s.company_id = $1 AND s.is_active = true
       GROUP BY s.id, s.name
       ORDER BY s.name`,
      [companyId]
    );
    const data = rows.rows.map(r => {
      const totalMsg = parseInt(r.total_messages, 10) || 0;
      const replies = parseInt(r.total_replies, 10) || 0;
      return {
        sequence_id: r.sequence_id,
        sequence_name: r.sequence_name,
        total_enrollments: parseInt(r.total_enrollments, 10) || 0,
        active_enrollments: parseInt(r.active_enrollments, 10) || 0,
        completed_enrollments: parseInt(r.completed_enrollments, 10) || 0,
        total_messages: totalMsg,
        total_replies: replies,
        reply_rate: totalMsg > 0 ? Math.round((replies / totalMsg) * 100) : 0,
        positive_replies: parseInt(r.positive_replies, 10) || 0,
        negative_replies: parseInt(r.negative_replies, 10) || 0,
      };
    });
    res.json({ data });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// GET /api/warming/analytics — follow-up analytics over time
router.get('/analytics', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const days = Math.min(parseInt(req.query.days, 10) || 30, 90);
    const rows = await pool.query(
      `SELECT period_date, sequence_id, messages_sent, replies_received,
              positive_replies, negative_replies, escalations, conversions
       FROM follow_up_analytics
       WHERE company_id = $1 AND period_date >= CURRENT_DATE - $2::int
       ORDER BY period_date DESC`,
      [companyId, days]
    );
    res.json({ data: rows.rows });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ──────────────────────────────────────────────
// Enrollment control endpoints
// ──────────────────────────────────────────────

// POST /api/warming/enrollments/:id/pause
router.post('/enrollments/:id/pause', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const id = req.params.id;
    if (!id || !UUID_REGEX.test(id)) return errorJson(res, 400, 'VALIDATION_ERROR', 'Valid enrollment ID required');
    const r = await pool.query(
      `UPDATE warming_enrollments SET paused = true
       WHERE id = $1 AND company_id = $2 AND status = 'active' RETURNING id`,
      [id, companyId]
    );
    if (!r.rows[0]) return errorJson(res, 404, 'NOT_FOUND', 'Enrollment not found or not active');
    res.json({ paused: true, id });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// POST /api/warming/enrollments/:id/resume
router.post('/enrollments/:id/resume', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const id = req.params.id;
    if (!id || !UUID_REGEX.test(id)) return errorJson(res, 400, 'VALIDATION_ERROR', 'Valid enrollment ID required');
    const r = await pool.query(
      `UPDATE warming_enrollments SET paused = false
       WHERE id = $1 AND company_id = $2 AND status = 'active' RETURNING id`,
      [id, companyId]
    );
    if (!r.rows[0]) return errorJson(res, 404, 'NOT_FOUND', 'Enrollment not found or not active');
    res.json({ resumed: true, id });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// POST /api/warming/enrollments/:id/skip — skip current step and advance
router.post('/enrollments/:id/skip', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const id = req.params.id;
    if (!id || !UUID_REGEX.test(id)) return errorJson(res, 400, 'VALIDATION_ERROR', 'Valid enrollment ID required');
    const enr = await pool.query(
      `SELECT e.id, e.sequence_id, e.current_step, e.status
       FROM warming_enrollments e WHERE e.id = $1 AND e.company_id = $2`,
      [id, companyId]
    );
    if (!enr.rows[0]) return errorJson(res, 404, 'NOT_FOUND', 'Enrollment not found');
    if (enr.rows[0].status !== 'active') return errorJson(res, 400, 'INVALID_STATE', 'Enrollment is not active');
    const currentStep = enr.rows[0].current_step || 1;
    const nextStep = await pool.query(
      `SELECT id, step_order, delay_minutes FROM warming_steps
       WHERE sequence_id = $1 AND step_order > $2 ORDER BY step_order ASC LIMIT 1`,
      [enr.rows[0].sequence_id, currentStep]
    );
    if (!nextStep.rows[0]) {
      await pool.query(
        `UPDATE warming_enrollments SET status = 'completed', completed_at = NOW() WHERE id = $1`,
        [id]
      );
      return res.json({ skipped: true, completed: true, id });
    }
    const next = nextStep.rows[0];
    await pool.query(
      `UPDATE warming_enrollments SET current_step = $2 WHERE id = $1`,
      [id, next.step_order]
    );
    const delayMs = Math.max(0, (next.delay_minutes || 0) * 60 * 1000);
    await warmingService.getQueue().add(
      'warming_step',
      { enrollmentId: id, stepId: next.id },
      { jobId: `warming-${id}-${next.id}`, delay: delayMs }
    );
    res.json({ skipped: true, next_step: next.step_order, id });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// PUT /api/warming/steps/:id — update a single step (conditions, template, type, etc.)
router.put('/steps/:id', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const id = req.params.id;
    if (!id || !UUID_REGEX.test(id)) return errorJson(res, 400, 'VALIDATION_ERROR', 'Valid step ID required');
    // Verify step belongs to a sequence owned by this company
    const verify = await pool.query(
      `SELECT ws.id FROM warming_steps ws
       JOIN warming_sequences s ON s.id = ws.sequence_id
       WHERE ws.id = $1 AND s.company_id = $2`,
      [id, companyId]
    );
    if (!verify.rows[0]) return errorJson(res, 404, 'NOT_FOUND', 'Step not found');
    const { delay_minutes, message_template, step_type, conditions, ai_context_prompt } = req.body || {};
    const updates = [];
    const params = [id];
    let idx = 2;
    if (delay_minutes !== undefined) { updates.push(`delay_minutes = $${idx++}`); params.push(Math.max(0, parseInt(delay_minutes, 10) || 0)); }
    if (message_template !== undefined) { updates.push(`message_template = $${idx++}`); params.push(String(message_template)); }
    if (step_type !== undefined) { updates.push(`step_type = $${idx++}`); params.push(String(step_type).substring(0, 30)); }
    if (conditions !== undefined) { updates.push(`conditions = $${idx++}`); params.push(conditions ? JSON.stringify(conditions) : null); }
    if (ai_context_prompt !== undefined) { updates.push(`ai_context_prompt = $${idx++}`); params.push(ai_context_prompt ? String(ai_context_prompt) : null); }
    if (updates.length === 0) return errorJson(res, 400, 'VALIDATION_ERROR', 'No fields to update');
    const r = await pool.query(
      `UPDATE warming_steps SET ${updates.join(', ')} WHERE id = $1
       RETURNING id, sequence_id, step_order, delay_minutes, message_template, step_type, conditions, ai_context_prompt`,
      params
    );
    res.json(r.rows[0]);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// POST /api/warming/message-log/:messageId/reply — mark a message as replied to (with sentiment)
router.post('/message-log/:messageId/reply', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const messageId = req.params.messageId;
    if (!messageId || !UUID_REGEX.test(messageId)) return errorJson(res, 400, 'VALIDATION_ERROR', 'Valid message ID required');
    const { sentiment } = req.body || {};
    const r = await pool.query(
      `UPDATE warming_message_log SET lead_replied = true, replied_at = NOW(),
              reply_sentiment = $2
       WHERE id = $1 RETURNING id`,
      [messageId, sentiment ? String(sentiment).substring(0, 20) : null]
    );
    if (!r.rows[0]) return errorJson(res, 404, 'NOT_FOUND', 'Message not found');
    res.json({ updated: true, id: messageId });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

module.exports = router;
