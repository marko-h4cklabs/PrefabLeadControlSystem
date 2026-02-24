const express = require('express');
const router = express.Router();
const { pool } = require('../../../db');
const { errorJson } = require('../middleware/errors');

// GET /api/autoresponder/rules
router.get('/rules', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const r = await pool.query(
      `SELECT id, company_id, name, trigger_type, trigger_value, action_type, action_value, is_active, priority, match_count, created_at
       FROM autoresponder_rules WHERE company_id = $1 ORDER BY priority DESC, created_at ASC`,
      [companyId]
    );
    const items = (r.rows || []).map((row) => ({
      id: row.id,
      company_id: row.company_id,
      name: row.name,
      trigger_type: row.trigger_type,
      trigger_value: row.trigger_value ?? null,
      action_type: row.action_type,
      action_value: row.action_value ?? null,
      is_active: row.is_active !== false,
      priority: row.priority ?? 0,
      match_count: row.match_count ?? 0,
      created_at: row.created_at,
    }));
    return res.json({ items });
  } catch (err) {
    console.error('[autoresponder] list:', err.message);
    return errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to list rules');
  }
});

// POST /api/autoresponder/rules
router.post('/rules', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { name, trigger_type, trigger_value, action_type, action_value, is_active, priority } = req.body || {};
    if (!name || !trigger_type || !action_type) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'name, trigger_type, and action_type are required');
    }
    const r = await pool.query(
      `INSERT INTO autoresponder_rules (company_id, name, trigger_type, trigger_value, action_type, action_value, is_active, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, company_id, name, trigger_type, trigger_value, action_type, action_value, is_active, priority, match_count, created_at`,
      [
        companyId,
        String(name).trim(),
        String(trigger_type).trim(),
        trigger_value != null ? String(trigger_value).trim() : null,
        String(action_type).trim(),
        action_value != null ? String(action_value).trim() : null,
        is_active !== false,
        priority != null ? parseInt(priority, 10) : 0,
      ]
    );
    return res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error('[autoresponder] create:', err.message);
    return errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to create rule');
  }
});

// PUT /api/autoresponder/rules/:id
router.put('/rules/:id', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const id = req.params.id;
    const { name, trigger_type, trigger_value, action_type, action_value, is_active, priority } = req.body || {};
    const updates = [];
    const values = [id, companyId];
    let idx = 3;
    if (name !== undefined) {
      updates.push(`name = $${idx++}`);
      values.push(String(name).trim());
    }
    if (trigger_type !== undefined) {
      updates.push(`trigger_type = $${idx++}`);
      values.push(String(trigger_type).trim());
    }
    if (trigger_value !== undefined) {
      updates.push(`trigger_value = $${idx++}`);
      values.push(trigger_value === null ? null : String(trigger_value).trim());
    }
    if (action_type !== undefined) {
      updates.push(`action_type = $${idx++}`);
      values.push(String(action_type).trim());
    }
    if (action_value !== undefined) {
      updates.push(`action_value = $${idx++}`);
      values.push(action_value === null ? null : String(action_value).trim());
    }
    if (typeof is_active === 'boolean') {
      updates.push(`is_active = $${idx++}`);
      values.push(is_active);
    }
    if (priority !== undefined) {
      updates.push(`priority = $${idx++}`);
      values.push(parseInt(priority, 10));
    }
    if (updates.length === 0) {
      const r = await pool.query(
        'SELECT * FROM autoresponder_rules WHERE id = $1 AND company_id = $2',
        [id, companyId]
      );
      if (!r.rows[0]) return errorJson(res, 404, 'NOT_FOUND', 'Rule not found');
      return res.json(r.rows[0]);
    }
    const r = await pool.query(
      `UPDATE autoresponder_rules SET ${updates.join(', ')} WHERE id = $1 AND company_id = $2 RETURNING *`,
      values
    );
    if (!r.rows[0]) return errorJson(res, 404, 'NOT_FOUND', 'Rule not found');
    return res.json(r.rows[0]);
  } catch (err) {
    console.error('[autoresponder] update:', err.message);
    return errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to update rule');
  }
});

// DELETE /api/autoresponder/rules/:id
router.delete('/rules/:id', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const id = req.params.id;
    const r = await pool.query(
      'DELETE FROM autoresponder_rules WHERE id = $1 AND company_id = $2 RETURNING id',
      [id, companyId]
    );
    if (!r.rows[0]) return errorJson(res, 404, 'NOT_FOUND', 'Rule not found');
    return res.json({ success: true, id });
  } catch (err) {
    console.error('[autoresponder] delete:', err.message);
    return errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to delete rule');
  }
});

// PUT /api/autoresponder/rules/reorder — body { rule_ids: [uuid, ...] }
router.put('/rules/reorder', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const ruleIds = Array.isArray(req.body?.rule_ids) ? req.body.rule_ids : [];
    for (let i = 0; i < ruleIds.length; i++) {
      await pool.query(
        'UPDATE autoresponder_rules SET priority = $1 WHERE id = $2 AND company_id = $3',
        [ruleIds.length - i, ruleIds[i], companyId]
      );
    }
    const r = await pool.query(
      'SELECT id, name, priority FROM autoresponder_rules WHERE company_id = $1 ORDER BY priority DESC',
      [companyId]
    );
    return res.json({ items: r.rows || [] });
  } catch (err) {
    console.error('[autoresponder] reorder:', err.message);
    return errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to reorder rules');
  }
});

module.exports = router;
