const express = require('express');
const router = express.Router();
const { pool } = require('../../../db');
const { errorJson } = require('../middleware/errors');

function extractVariables(content) {
  if (typeof content !== 'string') return [];
  const matches = content.match(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g) || [];
  return [...new Set(matches.map((m) => m.slice(1, -1)))];
}

// GET /api/chatbot/templates — grouped by category
router.get('/', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const r = await pool.query(
      `SELECT id, company_id, name, category, content, variables, use_count, created_at
       FROM message_templates WHERE company_id = $1 ORDER BY category, name`,
      [companyId]
    );
    const byCategory = {};
    for (const row of r.rows || []) {
      const cat = row.category || 'general';
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push({
        id: row.id,
        name: row.name,
        category: row.category ?? 'general',
        content: row.content,
        variables: Array.isArray(row.variables) ? row.variables : (row.variables || []),
        use_count: row.use_count ?? 0,
        created_at: row.created_at,
      });
    }
    return res.json({ by_category: byCategory });
  } catch (err) {
    console.error('[chatbot/templates] list:', err.message);
    return errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to list templates');
  }
});

// POST /api/chatbot/templates
router.post('/', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { name, category, content } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'name is required');
    }
    if (!content || typeof content !== 'string') {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'content is required');
    }
    const variables = extractVariables(content);
    const r = await pool.query(
      `INSERT INTO message_templates (company_id, name, category, content, variables)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, company_id, name, category, content, variables, use_count, created_at`,
      [companyId, name.trim(), (category && String(category).trim()) || 'general', content.trim(), variables]
    );
    return res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error('[chatbot/templates] create:', err.message);
    return errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to create template');
  }
});

// PUT /api/chatbot/templates/:id
router.put('/:id', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const id = req.params.id;
    const { name, category, content } = req.body || {};
    const updates = [];
    const values = [id, companyId];
    let idx = 3;
    if (name !== undefined) {
      updates.push(`name = $${idx++}`);
      values.push(String(name).trim());
    }
    if (category !== undefined) {
      updates.push(`category = $${idx++}`);
      values.push(String(category).trim());
    }
    if (content !== undefined) {
      updates.push(`content = $${idx++}`);
      values.push(String(content).trim());
      const variables = extractVariables(content);
      updates.push(`variables = $${idx++}`);
      values.push(variables);
    }
    if (updates.length === 0) {
      const r = await pool.query(
        'SELECT id, company_id, name, category, content, variables, use_count, created_at FROM message_templates WHERE id = $1 AND company_id = $2',
        [id, companyId]
      );
      if (!r.rows[0]) return errorJson(res, 404, 'NOT_FOUND', 'Template not found');
      return res.json(r.rows[0]);
    }
    const r = await pool.query(
      `UPDATE message_templates SET ${updates.join(', ')} WHERE id = $1 AND company_id = $2
       RETURNING id, company_id, name, category, content, variables, use_count, created_at`,
      values
    );
    if (!r.rows[0]) return errorJson(res, 404, 'NOT_FOUND', 'Template not found');
    return res.json(r.rows[0]);
  } catch (err) {
    console.error('[chatbot/templates] update:', err.message);
    return errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to update template');
  }
});

// DELETE /api/chatbot/templates/:id
router.delete('/:id', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const id = req.params.id;
    const r = await pool.query(
      'DELETE FROM message_templates WHERE id = $1 AND company_id = $2 RETURNING id',
      [id, companyId]
    );
    if (!r.rows[0]) return errorJson(res, 404, 'NOT_FOUND', 'Template not found');
    return res.json({ success: true, id });
  } catch (err) {
    console.error('[chatbot/templates] delete:', err.message);
    return errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to delete template');
  }
});

// POST /api/chatbot/templates/:id/use
router.post('/:id/use', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const id = req.params.id;
    const r = await pool.query(
      `UPDATE message_templates SET use_count = COALESCE(use_count, 0) + 1 WHERE id = $1 AND company_id = $2
       RETURNING id, name, content, variables`,
      [id, companyId]
    );
    if (!r.rows[0]) return errorJson(res, 404, 'NOT_FOUND', 'Template not found');
    const row = r.rows[0];
    const variables = Array.isArray(row.variables) ? row.variables : [];
    return res.json({ content: row.content, variables });
  } catch (err) {
    console.error('[chatbot/templates] use:', err.message);
    return errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to use template');
  }
});

module.exports = router;
