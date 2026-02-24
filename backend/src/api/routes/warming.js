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
      `SELECT id, company_id, name, trigger_event, is_active, created_at
       FROM warming_sequences WHERE company_id = $1 ORDER BY name`,
      [companyId]
    );
    const stepsBySeq = await pool.query(
      `SELECT id, sequence_id, step_order, delay_minutes, message_template, step_type, created_at
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
        created_at: st.created_at,
      });
    }
    const data = (seqs.rows || []).map((s) => ({
      id: s.id,
      company_id: s.company_id,
      name: s.name,
      trigger_event: s.trigger_event,
      is_active: Boolean(s.is_active),
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
    const { name, trigger_event, steps } = req.body || {};
    if (!name || !trigger_event || !Array.isArray(steps) || steps.length === 0) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'name, trigger_event, and steps (non-empty array) required');
    }
    const seq = await pool.query(
      `INSERT INTO warming_sequences (company_id, name, trigger_event, is_active)
       VALUES ($1, $2, $3, true) RETURNING id, name, trigger_event, is_active, created_at`,
      [companyId, String(name).trim(), String(trigger_event).trim()]
    );
    const seqId = seq.rows[0].id;
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      await pool.query(
        `INSERT INTO warming_steps (sequence_id, step_order, delay_minutes, message_template, step_type)
         VALUES ($1, $2, $3, $4, $5)`,
        [seqId, i + 1, Math.max(0, parseInt(st.delay_minutes, 10) || 0), String(st.message_template || '').trim(), (st.step_type || 'message').substring(0, 30)]
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
    const { name, is_active } = req.body || {};
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

// GET /api/warming/enrollments — active enrollments with lead name, sequence name, current step, enrolled_at
router.get('/enrollments', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const rows = await pool.query(
      `SELECT e.id, e.lead_id, e.sequence_id, e.enrolled_at, e.current_step, e.status,
              l.name AS lead_name, s.name AS sequence_name
       FROM warming_enrollments e
       JOIN leads l ON l.id = e.lead_id
       JOIN warming_sequences s ON s.id = e.sequence_id
       WHERE e.company_id = $1 AND e.status = 'active'
       ORDER BY e.enrolled_at DESC`,
      [companyId]
    );
    const data = (rows.rows || []).map((r) => ({
      id: r.id,
      lead_id: r.lead_id,
      sequence_id: r.sequence_id,
      lead_name: r.lead_name ?? null,
      sequence_name: r.sequence_name ?? null,
      current_step: parseInt(r.current_step, 10) || 0,
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

module.exports = router;
