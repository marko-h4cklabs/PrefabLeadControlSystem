const express = require('express');
const router = express.Router();
const { pool } = require('../../../db');
const { errorJson } = require('../middleware/errors');

// GET /api/chatbot/personas
router.get('/', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const r = await pool.query(
      `SELECT id, company_id, name, agent_name, system_prompt, tone, opener_style, is_active, is_default, created_at
       FROM chatbot_personas WHERE company_id = $1 ORDER BY name`,
      [companyId]
    );
    const items = (r.rows || []).map((row) => ({
      id: row.id,
      company_id: row.company_id,
      name: row.name,
      agent_name: row.agent_name ?? 'Jarvis',
      system_prompt: row.system_prompt ?? null,
      tone: row.tone ?? 'professional',
      opener_style: row.opener_style ?? 'casual',
      is_active: row.is_active === true,
      is_default: row.is_default === true,
      created_at: row.created_at,
    }));
    return res.json({ items });
  } catch (err) {
    console.error('[chatbot/personas] list:', err.message);
    return errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to list personas');
  }
});

// POST /api/chatbot/personas
router.post('/', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { name, agent_name, system_prompt, tone, opener_style } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'name is required');
    }
    const r = await pool.query(
      `INSERT INTO chatbot_personas (company_id, name, agent_name, system_prompt, tone, opener_style)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, company_id, name, agent_name, system_prompt, tone, opener_style, is_active, is_default, created_at`,
      [
        companyId,
        name.trim(),
        (agent_name && String(agent_name).trim()) || 'Jarvis',
        (system_prompt && String(system_prompt).trim()) || null,
        (tone && String(tone).trim()) || 'professional',
        (opener_style && String(opener_style).trim()) || 'casual',
      ]
    );
    const row = r.rows[0];
    return res.status(201).json(row);
  } catch (err) {
    console.error('[chatbot/personas] create:', err.message);
    return errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to create persona');
  }
});

// PUT /api/chatbot/personas/:id
router.put('/:id', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const id = req.params.id;
    const { name, agent_name, system_prompt, tone, opener_style } = req.body || {};
    const updates = [];
    const values = [id, companyId];
    let idx = 3;
    if (name !== undefined) {
      updates.push(`name = $${idx++}`);
      values.push(String(name).trim());
    }
    if (agent_name !== undefined) {
      updates.push(`agent_name = $${idx++}`);
      values.push(String(agent_name).trim());
    }
    if (system_prompt !== undefined) {
      updates.push(`system_prompt = $${idx++}`);
      values.push(system_prompt === null ? null : String(system_prompt).trim());
    }
    if (tone !== undefined) {
      updates.push(`tone = $${idx++}`);
      values.push(String(tone).trim());
    }
    if (opener_style !== undefined) {
      updates.push(`opener_style = $${idx++}`);
      values.push(String(opener_style).trim());
    }
    if (updates.length === 0) {
      const r = await pool.query(
        'SELECT id, company_id, name, agent_name, system_prompt, tone, opener_style, is_active, is_default, created_at FROM chatbot_personas WHERE id = $1 AND company_id = $2',
        [id, companyId]
      );
      if (!r.rows[0]) return errorJson(res, 404, 'NOT_FOUND', 'Persona not found');
      return res.json(r.rows[0]);
    }
    const r = await pool.query(
      `UPDATE chatbot_personas SET ${updates.join(', ')} WHERE id = $1 AND company_id = $2
       RETURNING id, company_id, name, agent_name, system_prompt, tone, opener_style, is_active, is_default, created_at`,
      values
    );
    if (!r.rows[0]) return errorJson(res, 404, 'NOT_FOUND', 'Persona not found');
    return res.json(r.rows[0]);
  } catch (err) {
    console.error('[chatbot/personas] update:', err.message);
    return errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to update persona');
  }
});

// PUT /api/chatbot/personas/:id/activate
// Swaps the activated persona into Agent Identity and saves the current identity as a persona
router.put('/:id/activate', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const id = req.params.id;

    // 1. Read the persona to activate
    const personaRes = await pool.query(
      'SELECT id, name, agent_name, system_prompt, tone, opener_style FROM chatbot_personas WHERE id = $1 AND company_id = $2',
      [id, companyId]
    );
    if (!personaRes.rows[0]) return errorJson(res, 404, 'NOT_FOUND', 'Persona not found');
    const persona = personaRes.rows[0];

    // 2. Read current agent identity from chatbot_behavior
    const behaviorRes = await pool.query(
      'SELECT agent_name, agent_backstory, tone FROM chatbot_behavior WHERE company_id = $1',
      [companyId]
    );
    const currentIdentity = behaviorRes.rows[0];

    // 3. Save current identity as a persona (unless it has no name)
    if (currentIdentity && currentIdentity.agent_name && currentIdentity.agent_name.trim()) {
      // Check if there's already a persona for this identity (matching agent_name)
      const existing = await pool.query(
        'SELECT id FROM chatbot_personas WHERE company_id = $1 AND is_active = true',
        [companyId]
      );
      if (existing.rows[0]) {
        // Update the currently active persona with the current identity values
        await pool.query(
          `UPDATE chatbot_personas SET agent_name = $3, system_prompt = $4, tone = $5, is_active = false
           WHERE id = $1 AND company_id = $2`,
          [existing.rows[0].id, companyId, currentIdentity.agent_name, currentIdentity.agent_backstory ?? null, currentIdentity.tone ?? 'professional']
        );
      } else {
        // Create a new persona from current identity
        await pool.query(
          `INSERT INTO chatbot_personas (company_id, name, agent_name, system_prompt, tone, opener_style, is_active, is_default)
           VALUES ($1, $2, $3, $4, $5, 'greeting', false, false)`,
          [companyId, currentIdentity.agent_name, currentIdentity.agent_name, currentIdentity.agent_backstory ?? null, currentIdentity.tone ?? 'professional']
        );
      }
    } else {
      // No current identity to save, just deactivate all
      await pool.query('UPDATE chatbot_personas SET is_active = false WHERE company_id = $1', [companyId]);
    }

    // 4. Copy activated persona into chatbot_behavior (agent identity)
    await pool.query(
      `UPDATE chatbot_behavior SET agent_name = $2, agent_backstory = $3, tone = $4, updated_at = NOW()
       WHERE company_id = $1`,
      [companyId, persona.agent_name || persona.name, persona.system_prompt ?? '', persona.tone ?? 'professional']
    );

    // 5. Mark new persona as active
    await pool.query(
      'UPDATE chatbot_personas SET is_active = true WHERE id = $1 AND company_id = $2',
      [id, companyId]
    );

    return res.json({ success: true, id: persona.id, name: persona.name, is_active: true });
  } catch (err) {
    console.error('[chatbot/personas] activate:', err.message);
    return errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to activate persona');
  }
});

// DELETE /api/chatbot/personas/:id
router.delete('/:id', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const id = req.params.id;
    const check = await pool.query(
      'SELECT id, is_active FROM chatbot_personas WHERE id = $1 AND company_id = $2',
      [id, companyId]
    );
    if (!check.rows[0]) return errorJson(res, 404, 'NOT_FOUND', 'Persona not found');
    if (check.rows[0].is_active) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'Cannot delete active persona. Activate another first.');
    }
    await pool.query('DELETE FROM chatbot_personas WHERE id = $1 AND company_id = $2', [id, companyId]);
    return res.json({ success: true, id });
  } catch (err) {
    console.error('[chatbot/personas] delete:', err.message);
    return errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to delete persona');
  }
});

module.exports = router;
