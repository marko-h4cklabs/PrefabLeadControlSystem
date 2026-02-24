const express = require('express');
const router = express.Router();
const { pool } = require('../../../db');
const { errorJson } = require('../middleware/errors');

// GET /api/team — all team members for company
router.get('/', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const r = await pool.query(
      `SELECT id, company_id, name, email, role, is_active, created_at
       FROM team_members WHERE company_id = $1 ORDER BY name`,
      [companyId]
    );
    const items = (r.rows || []).map((row) => ({
      id: row.id,
      company_id: row.company_id,
      name: row.name,
      email: row.email ?? null,
      role: row.role ?? 'setter',
      is_active: row.is_active !== false,
      created_at: row.created_at,
    }));
    return res.json({ items });
  } catch (err) {
    console.error('[team] list:', err.message);
    return errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to list team');
  }
});

// POST /api/team — create team member
router.post('/', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { name, email, role } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'name is required');
    }
    const r = await pool.query(
      `INSERT INTO team_members (company_id, name, email, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, company_id, name, email, role, is_active, created_at`,
      [companyId, name.trim(), (email && String(email).trim()) || null, (role && String(role).trim()) || 'setter']
    );
    const row = r.rows[0];
    return res.status(201).json({
      id: row.id,
      company_id: row.company_id,
      name: row.name,
      email: row.email ?? null,
      role: row.role ?? 'setter',
      is_active: row.is_active !== false,
      created_at: row.created_at,
    });
  } catch (err) {
    console.error('[team] create:', err.message);
    return errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to create team member');
  }
});

// PUT /api/team/:id
router.put('/:id', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const id = req.params.id;
    const { name, email, role, is_active } = req.body || {};
    const updates = [];
    const values = [id, companyId];
    let idx = 3;
    if (name !== undefined) {
      updates.push(`name = $${idx++}`);
      values.push(String(name).trim());
    }
    if (email !== undefined) {
      updates.push(`email = $${idx++}`);
      values.push(email === null || email === '' ? null : String(email).trim());
    }
    if (role !== undefined) {
      updates.push(`role = $${idx++}`);
      values.push(String(role).trim());
    }
    if (typeof is_active === 'boolean') {
      updates.push(`is_active = $${idx++}`);
      values.push(is_active);
    }
    if (updates.length === 0) {
      const r = await pool.query(
        'SELECT id, company_id, name, email, role, is_active, created_at FROM team_members WHERE id = $1 AND company_id = $2',
        [id, companyId]
      );
      if (!r.rows[0]) return errorJson(res, 404, 'NOT_FOUND', 'Team member not found');
      return res.json(r.rows[0]);
    }
    const r = await pool.query(
      `UPDATE team_members SET ${updates.join(', ')} WHERE id = $1 AND company_id = $2
       RETURNING id, company_id, name, email, role, is_active, created_at`,
      values
    );
    if (!r.rows[0]) return errorJson(res, 404, 'NOT_FOUND', 'Team member not found');
    return res.json(r.rows[0]);
  } catch (err) {
    console.error('[team] update:', err.message);
    return errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to update team member');
  }
});

// DELETE /api/team/:id — soft delete (set is_active = false)
router.delete('/:id', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const id = req.params.id;
    const r = await pool.query(
      'UPDATE team_members SET is_active = false WHERE id = $1 AND company_id = $2 RETURNING id',
      [id, companyId]
    );
    if (!r.rows[0]) return errorJson(res, 404, 'NOT_FOUND', 'Team member not found');
    return res.json({ success: true, id });
  } catch (err) {
    console.error('[team] delete:', err.message);
    return errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to delete team member');
  }
});

// GET /api/team/performance — must be before /:id/performance
router.get('/performance', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const from = req.query.from || null;
    const to = req.query.to || null;
    let sql = `
      SELECT sp.setter_id, sp.setter_name, sp.date,
             sp.conversations_handled, sp.replies_sent, sp.leads_qualified,
             sp.calls_booked, sp.deals_closed, sp.revenue_attributed, sp.avg_response_time_minutes
      FROM setter_performance sp
      WHERE sp.company_id = $1`;
    const params = [companyId];
    let idx = 2;
    if (from) {
      sql += ` AND sp.date >= $${idx++}`;
      params.push(from);
    }
    if (to) {
      sql += ` AND sp.date <= $${idx++}`;
      params.push(to);
    }
    sql += ` ORDER BY sp.date DESC, sp.setter_name`;
    const r = await pool.query(sql, params);
    const bySetter = {};
    for (const row of r.rows || []) {
      const key = row.setter_id || row.setter_name || 'unknown';
      if (!bySetter[key]) {
        bySetter[key] = {
          setter_id: row.setter_id,
          setter_name: row.setter_name,
          conversations_handled: 0,
          replies_sent: 0,
          leads_qualified: 0,
          calls_booked: 0,
          deals_closed: 0,
          revenue_attributed: 0,
          avg_response_time_minutes: 0,
        };
      }
      bySetter[key].conversations_handled += row.conversations_handled || 0;
      bySetter[key].replies_sent += row.replies_sent || 0;
      bySetter[key].leads_qualified += row.leads_qualified || 0;
      bySetter[key].calls_booked += row.calls_booked || 0;
      bySetter[key].deals_closed += row.deals_closed || 0;
      bySetter[key].revenue_attributed += Number(row.revenue_attributed) || 0;
    }
    const items = Object.values(bySetter);
    return res.json({ items });
  } catch (err) {
    console.error('[team] performance:', err.message);
    return errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to get performance');
  }
});

// GET /api/team/:id/performance
router.get('/:id/performance', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const id = req.params.id;
    const r = await pool.query(
      `SELECT date, conversations_handled, replies_sent, leads_qualified, calls_booked, deals_closed, revenue_attributed, avg_response_time_minutes
       FROM setter_performance WHERE setter_id = $1 AND company_id = $2 ORDER BY date DESC`,
      [id, companyId]
    );
    return res.json({ setter_id: id, rows: r.rows || [] });
  } catch (err) {
    console.error('[team] performance detail:', err.message);
    return errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to get performance');
  }
});

module.exports = router;
