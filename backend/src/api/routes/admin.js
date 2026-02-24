const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const { pool } = require('../../../db');
const {
  analyticsSnapshotRepository,
  companyRepository,
  leadRepository,
  userRepository,
} = require('../../../db/repositories');
const queueService = require('../../../services/queueService');
const { errorJson } = require('../middleware/errors');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function escapeIlikePattern(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

// POST /api/admin/make-admin — only callable by is_admin users (enforced by isAdminMiddleware)
router.post('/make-admin', async (req, res) => {
  try {
    const { user_id: userId } = req.body ?? {};
    if (!userId || !UUID_REGEX.test(userId)) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'user_id (UUID) required');
    }
    const updated = await userRepository.setIsAdmin(userId, true);
    if (!updated) {
      return errorJson(res, 404, 'NOT_FOUND', 'User not found');
    }
    res.json({ success: true, user_id: userId });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// GET /api/admin/stats — aggregate counts from DB
router.get('/stats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM companies) AS total_companies,
        (SELECT COUNT(*)::int FROM leads) AS total_leads,
        (SELECT COUNT(*)::int FROM chat_conversations) AS total_conversations,
        (SELECT COUNT(*)::int FROM appointments) AS total_appointments,
        (SELECT COUNT(*)::int FROM chat_messages WHERE created_at::date = CURRENT_DATE) AS total_messages_today,
        (SELECT COUNT(*)::int FROM hot_lead_alerts WHERE dismissed_at IS NULL) AS hot_leads_active,
        (SELECT COUNT(*)::int FROM users WHERE created_at::date = CURRENT_DATE) AS new_signups_today
    `);
    const row = result.rows[0];
    res.json({
      total_companies: parseInt(row?.total_companies, 10) || 0,
      total_leads: parseInt(row?.total_leads, 10) || 0,
      total_conversations: parseInt(row?.total_conversations, 10) || 0,
      total_appointments: parseInt(row?.total_appointments, 10) || 0,
      total_messages_today: parseInt(row?.total_messages_today, 10) || 0,
      hot_leads_active: parseInt(row?.hot_leads_active, 10) || 0,
      new_signups_today: parseInt(row?.new_signups_today, 10) || 0,
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// GET /api/admin/companies — paginated list, ?search= & ?page= & ?limit=
router.get('/companies', async (req, res) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const offset = (page - 1) * limit;

    let sql = `
      SELECT c.id, c.name, c.created_at, c.operating_mode,
        (c.manychat_api_key IS NOT NULL) AS manychat_connected,
        COUNT(DISTINCT l.id)::int AS lead_count,
        COUNT(DISTINCT cc.id)::int AS conversation_count,
        MAX(m.created_at) AS last_active
      FROM companies c
      LEFT JOIN leads l ON l.company_id = c.id
      LEFT JOIN chat_conversations cc ON cc.company_id = c.id
      LEFT JOIN chat_messages m ON m.conversation_id = cc.id
    `;
    const params = [];
    let paramIndex = 1;
    if (search) {
      params.push('%' + escapeIlikePattern(search) + '%');
      sql += ` WHERE c.name ILIKE $${paramIndex}`;
      paramIndex++;
    }
    sql += ' GROUP BY c.id, c.name, c.created_at, c.operating_mode, c.manychat_api_key ORDER BY c.created_at DESC';
    params.push(limit, offset);
    sql += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;

    const result = await pool.query(sql, params);
    const data = (result.rows || []).map((r) => ({
      id: r.id,
      name: r.name,
      created_at: r.created_at,
      operating_mode: r.operating_mode ?? null,
      lead_count: parseInt(r.lead_count, 10) || 0,
      conversation_count: parseInt(r.conversation_count, 10) || 0,
      last_active: r.last_active ?? null,
      manychat_connected: Boolean(r.manychat_connected),
    }));
    res.json({ data });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// GET /api/admin/companies/:id — full company detail including last 5 leads
router.get('/companies/:id', async (req, res) => {
  try {
    const companyId = req.params.id;
    if (!companyId || !UUID_REGEX.test(companyId)) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'Valid company ID (UUID) required');
    }
    const company = await companyRepository.findById(companyId);
    if (!company) {
      return errorJson(res, 404, 'NOT_FOUND', 'Company not found');
    }
    const [
      leadsByStatus,
      leadsByChannel,
      totalLeads,
      totalConversations,
      messagesStats,
      totalAppointments,
      upcomingAppointments,
      usersList,
      lastLeads,
    ] = await Promise.all([
      pool.query(
        `SELECT status, COUNT(*)::int AS cnt FROM leads WHERE company_id = $1 GROUP BY status`,
        [companyId]
      ),
      pool.query(
        `SELECT channel, COUNT(*)::int AS cnt FROM leads WHERE company_id = $1 GROUP BY channel`,
        [companyId]
      ),
      pool.query('SELECT COUNT(*)::int AS cnt FROM leads WHERE company_id = $1', [companyId]),
      pool.query(
        'SELECT COUNT(*)::int AS cnt FROM chat_conversations WHERE company_id = $1',
        [companyId]
      ),
      pool.query(
        `SELECT
          SUM(CASE WHEN m.role = 'assistant' THEN 1 ELSE 0 END)::int AS sent,
          SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END)::int AS received
        FROM chat_messages m
        JOIN chat_conversations c ON m.conversation_id = c.id
        WHERE c.company_id = $1`,
        [companyId]
      ),
      pool.query('SELECT COUNT(*)::int AS cnt FROM appointments WHERE company_id = $1', [companyId]),
      pool.query(
        `SELECT COUNT(*)::int AS cnt FROM appointments
         WHERE company_id = $1 AND status = 'scheduled' AND start_at > NOW()`,
        [companyId]
      ),
      userRepository.findAll(companyId),
      pool.query(
        `SELECT id, name, channel, status, created_at, updated_at
         FROM leads WHERE company_id = $1 ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 5`,
        [companyId]
      ),
    ]);
    const leads_by_status = Object.fromEntries(
      (leadsByStatus.rows || []).map((r) => [r.status, parseInt(r.cnt, 10) || 0])
    );
    const leads_by_channel = Object.fromEntries(
      (leadsByChannel.rows || []).map((r) => [r.channel, parseInt(r.cnt, 10) || 0])
    );
    const msgRow = messagesStats.rows[0];
    const messages_sent = parseInt(msgRow?.sent, 10) || 0;
    const messages_received = parseInt(msgRow?.received, 10) || 0;
    const users = (usersList || []).map((u) => ({
      id: u.id,
      email: u.email,
      role: u.role,
      created_at: u.created_at,
    }));
    const last_5_leads = (lastLeads.rows || []).map((r) => ({
      id: r.id,
      name: r.name,
      channel: r.channel,
      status: r.status,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
    res.json({
      data: {
        company,
        stats: {
          total_leads: parseInt(totalLeads.rows[0]?.cnt, 10) || 0,
          leads_by_status,
          leads_by_channel,
          total_conversations: parseInt(totalConversations.rows[0]?.cnt, 10) || 0,
          messages_sent,
          messages_received,
          total_appointments: parseInt(totalAppointments.rows[0]?.cnt, 10) || 0,
          upcoming_appointments: parseInt(upcomingAppointments.rows[0]?.cnt, 10) || 0,
        },
        users,
        last_5_leads,
      },
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// POST /api/admin/impersonate — body { company_id }, returns { token, admin_token }
router.post('/impersonate', async (req, res) => {
  try {
    const { company_id: companyId } = req.body ?? {};
    if (!companyId || !UUID_REGEX.test(companyId)) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'company_id (UUID) required');
    }
    const company = await companyRepository.findById(companyId);
    if (!company) {
      return errorJson(res, 404, 'NOT_FOUND', 'Company not found');
    }
    const ownerResult = await pool.query(
      "SELECT id, email, role FROM users WHERE company_id = $1 AND role = 'owner' LIMIT 1",
      [companyId]
    );
    let targetUser = ownerResult.rows[0];
    if (!targetUser) {
      const adminResult = await pool.query(
        "SELECT id, email, role FROM users WHERE company_id = $1 AND role = 'admin' LIMIT 1",
        [companyId]
      );
      targetUser = adminResult.rows[0];
      if (!targetUser) {
        return errorJson(res, 404, 'NOT_FOUND', 'No owner or admin user found for this company');
      }
    }
    const adminUserId = req.adminUser?.id ?? req.user?.id;
    const impersonateToken = jwt.sign(
      {
        id: targetUser.id,
        companyId,
        role: targetUser.role,
        is_impersonation: true,
        original_admin_id: adminUserId,
      },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    const adminToken =
      req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
        ? req.headers.authorization.slice(7).trim()
        : null;
    res.json({
      impersonate_token: impersonateToken,
      admin_token: adminToken,
      company_id: companyId,
      company_name: company.name ?? null,
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// POST /api/admin/impersonate/end — body { admin_token }, validates and returns { restored: true }
router.post('/impersonate/end', async (req, res) => {
  try {
    const { admin_token: adminToken } = req.body ?? {};
    if (!adminToken || typeof adminToken !== 'string') {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'admin_token required');
    }
    try {
      jwt.verify(adminToken.trim(), process.env.JWT_SECRET);
    } catch {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'Invalid or expired admin_token');
    }
    res.json({ restored: true });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// GET /api/admin/workspaces (legacy; same as /companies)
router.get('/workspaces', async (req, res) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    let sql = `
      SELECT c.id, c.name, c.created_at,
        COUNT(DISTINCT l.id)::int AS lead_count,
        COUNT(DISTINCT u.id)::int AS user_count
      FROM companies c
      LEFT JOIN leads l ON l.company_id = c.id
      LEFT JOIN users u ON u.company_id = c.id
    `;
    const params = [];
    let paramIndex = 1;

    if (search) {
      params.push('%' + escapeIlikePattern(search) + '%');
      sql += ` WHERE c.name ILIKE $${paramIndex}`;
      paramIndex++;
    }

    sql += ' GROUP BY c.id, c.name, c.created_at ORDER BY c.created_at DESC';
    params.push(limit, offset);
    sql += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;

    const result = await pool.query(sql, params);
    const workspaces = (result.rows || []).map((r) => ({
      id: r.id,
      name: r.name,
      created_at: r.created_at,
      lead_count: parseInt(r.lead_count, 10) || 0,
      user_count: parseInt(r.user_count, 10) || 0,
    }));

    res.json({ data: workspaces });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// GET /api/admin/workspaces/:companyId/leads (must be before :companyId to match first)
router.get('/workspaces/:companyId/leads', async (req, res) => {
  try {
    const companyId = req.params.companyId;
    if (!companyId || !UUID_REGEX.test(companyId)) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'Valid company ID (UUID) required');
    }

    const company = await companyRepository.findById(companyId);
    if (!company) {
      return errorJson(res, 404, 'NOT_FOUND', 'Company not found');
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const leads = await leadRepository.findAll(companyId, { limit, offset });
    const total = await leadRepository.count(companyId, {});

    const leadsWithSummary = await Promise.all(
      leads.map(async (lead) => {
        const base = {
          id: lead.id,
          channel: lead.channel,
          name: lead.name ?? lead.external_id ?? null,
          status_id: lead.status_id ?? null,
          status_name: lead.status_name ?? lead.status ?? null,
          created_at: lead.created_at,
          updated_at: lead.updated_at,
          source: lead.source ?? 'inbox',
        };
        try {
          base.collected_info = await leadRepository.getCollectedInfoSummary(lead.id, 120);
        } catch {
          base.collected_info = '';
        }
        return base;
      })
    );

    res.json({ data: { leads: leadsWithSummary, total } });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// POST /api/admin/workspaces/:companyId/impersonate (legacy; prefer POST /impersonate)
router.post('/workspaces/:companyId/impersonate', async (req, res) => {
  try {
    const companyId = req.params.companyId;
    if (!companyId || !UUID_REGEX.test(companyId)) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'Valid company ID (UUID) required');
    }

    const company = await companyRepository.findById(companyId);
    if (!company) {
      return errorJson(res, 404, 'NOT_FOUND', 'Company not found');
    }

    const ownerResult = await pool.query(
      "SELECT id, email, role FROM users WHERE company_id = $1 AND role = 'owner' LIMIT 1",
      [companyId]
    );
    let targetUser = ownerResult.rows[0];
    if (!targetUser) {
      const adminResult = await pool.query(
        "SELECT id, email, role FROM users WHERE company_id = $1 AND role = 'admin' LIMIT 1",
        [companyId]
      );
      targetUser = adminResult.rows[0];
      if (!targetUser) {
        return errorJson(res, 404, 'NOT_FOUND', 'No owner or admin user found for this company');
      }
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_impersonation_log (
        id SERIAL PRIMARY KEY,
        admin_user_id UUID NOT NULL,
        target_company_id UUID NOT NULL,
        target_user_id UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(
      `INSERT INTO admin_impersonation_log (admin_user_id, target_company_id, target_user_id)
       VALUES ($1, $2, $3)`,
      [req.user.id, companyId, targetUser.id]
    );

    const token = jwt.sign(
      { id: targetUser.id, companyId, role: targetUser.role },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.json({
      data: {
        token,
        user: { id: targetUser.id, email: targetUser.email, role: targetUser.role },
        company: { id: company.id, name: company.name },
      },
    });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// GET /api/admin/workspaces/:companyId
router.get('/workspaces/:companyId', async (req, res) => {
  try {
    const companyId = req.params.companyId;
    if (!companyId || !UUID_REGEX.test(companyId)) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'Valid company ID (UUID) required');
    }

    const company = await companyRepository.findById(companyId);
    if (!company) {
      return errorJson(res, 404, 'NOT_FOUND', 'Company not found');
    }

    const [
      leadsByStatus,
      leadsByChannel,
      totalLeads,
      totalConversations,
      messagesStats,
      totalAppointments,
      upcomingAppointments,
      usersList,
    ] = await Promise.all([
      pool.query(
        `SELECT status, COUNT(*)::int AS cnt FROM leads WHERE company_id = $1 GROUP BY status`,
        [companyId]
      ),
      pool.query(
        `SELECT channel, COUNT(*)::int AS cnt FROM leads WHERE company_id = $1 GROUP BY channel`,
        [companyId]
      ),
      pool.query('SELECT COUNT(*)::int AS cnt FROM leads WHERE company_id = $1', [companyId]),
      pool.query(
        'SELECT COUNT(*)::int AS cnt FROM chat_conversations WHERE company_id = $1',
        [companyId]
      ),
      pool.query(
        `SELECT
          SUM(CASE WHEN m.role = 'assistant' THEN 1 ELSE 0 END)::int AS sent,
          SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END)::int AS received
        FROM chat_messages m
        JOIN chat_conversations c ON m.conversation_id = c.id
        WHERE c.company_id = $1`,
        [companyId]
      ),
      pool.query('SELECT COUNT(*)::int AS cnt FROM appointments WHERE company_id = $1', [companyId]),
      pool.query(
        `SELECT COUNT(*)::int AS cnt FROM appointments
         WHERE company_id = $1 AND status = 'scheduled' AND start_at > NOW()`,
        [companyId]
      ),
      userRepository.findAll(companyId),
    ]);

    const leads_by_status = Object.fromEntries(
      (leadsByStatus.rows || []).map((r) => [r.status, parseInt(r.cnt, 10) || 0])
    );
    const leads_by_channel = Object.fromEntries(
      (leadsByChannel.rows || []).map((r) => [r.channel, parseInt(r.cnt, 10) || 0])
    );
    const msgRow = messagesStats.rows[0];
    const messages_sent = parseInt(msgRow?.sent, 10) || 0;
    const messages_received = parseInt(msgRow?.received, 10) || 0;

    const users = (usersList || []).map((u) => ({
      id: u.id,
      email: u.email,
      role: u.role,
      created_at: u.created_at,
    }));

    const data = {
      company,
      stats: {
        total_leads: parseInt(totalLeads.rows[0]?.cnt, 10) || 0,
        leads_by_status: leads_by_status,
        leads_by_channel: leads_by_channel,
        total_conversations: parseInt(totalConversations.rows[0]?.cnt, 10) || 0,
        messages_sent,
        messages_received,
        total_appointments: parseInt(totalAppointments.rows[0]?.cnt, 10) || 0,
        upcoming_appointments: parseInt(upcomingAppointments.rows[0]?.cnt, 10) || 0,
      },
      users,
    };

    res.json({ data });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// GET /api/admin/hot-leads — unresolved hot lead alerts, optional ?company_id=
router.get('/hot-leads', async (req, res) => {
  try {
    const companyId = req.query.company_id;
    let sql = `
      SELECT a.id, a.lead_id, a.company_id, a.trigger_reason, a.intent_score, a.created_at,
             l.name AS lead_name, l.channel AS lead_channel, c.name AS company_name
      FROM hot_lead_alerts a
      JOIN leads l ON l.id = a.lead_id
      LEFT JOIN companies c ON c.id = a.company_id
      WHERE a.dismissed_at IS NULL
    `;
    const params = [];
    if (companyId && UUID_REGEX.test(companyId)) {
      sql += ' AND a.company_id = $1';
      params.push(companyId);
    }
    sql += ' ORDER BY a.created_at DESC';
    const result = await pool.query(sql, params);
    const data = (result.rows || []).map((r) => ({
      id: r.id,
      lead_id: r.lead_id,
      company_id: r.company_id,
      company_name: r.company_name ?? null,
      trigger_reason: r.trigger_reason,
      intent_score: r.intent_score,
      created_at: r.created_at,
      lead_name: r.lead_name,
      lead_channel: r.lead_channel,
    }));
    res.json({ data });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// GET /api/admin/users — all users with company name, email, created_at, is_admin
router.get('/users', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.email, u.created_at, u.is_admin, u.company_id, c.name AS company_name
      FROM users u
      LEFT JOIN companies c ON c.id = u.company_id
      ORDER BY u.created_at DESC
    `);
    const data = (result.rows || []).map((r) => ({
      id: r.id,
      email: r.email,
      created_at: r.created_at,
      is_admin: Boolean(r.is_admin),
      company_id: r.company_id,
      company_name: r.company_name ?? null,
    }));
    res.json({ data });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// PUT /api/admin/users/:id/toggle-admin — toggle is_admin for a user
router.put('/users/:id/toggle-admin', async (req, res) => {
  try {
    const userId = req.params.id;
    if (!userId || !UUID_REGEX.test(userId)) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'Valid user ID (UUID) required');
    }
    const user = await userRepository.getUserById(userId);
    if (!user) {
      return errorJson(res, 404, 'NOT_FOUND', 'User not found');
    }
    const newValue = !user.is_admin;
    const updated = await userRepository.setIsAdmin(userId, newValue);
    if (!updated) {
      return errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to update user');
    }
    res.json({ user_id: userId, is_admin: updated.is_admin });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// GET /api/admin/queue/stats
router.get('/queue/stats', async (req, res) => {
  try {
    const data = await queueService.getQueueStats();
    res.json({ data });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// POST /api/admin/queue/follow-up
router.post('/queue/follow-up', async (req, res) => {
  try {
    const { leadId, companyId, type, delayMinutes, message } = req.body || {};
    if (!leadId || !companyId || !type) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'leadId, companyId, and type are required');
    }
    const validTypes = ['no_reply', 'post_quote', 'cold_lead', 'custom'];
    if (!validTypes.includes(type)) {
      return errorJson(res, 400, 'VALIDATION_ERROR', `type must be one of: ${validTypes.join(', ')}`);
    }
    if (type === 'custom' && (!message || typeof message !== 'string')) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'message is required for custom type');
    }
    const delayMs = Math.max(0, (parseInt(delayMinutes, 10) || 0) * 60000);
    const payload = type === 'custom' ? { message } : {};
    const result = await queueService.scheduleFollowUp(leadId, companyId, type, delayMs, payload);
    if (!result.queued) {
      return res.status(409).json({
        data: { queued: false, reason: result.reason ?? 'Job already exists', jobId: result.jobId },
      });
    }
    res.json({ data: { queued: true, jobId: result.jobId } });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// DELETE /api/admin/queue/follow-up/:leadId/:type
router.delete('/queue/follow-up/:leadId/:type', async (req, res) => {
  try {
    const { leadId, type } = req.params;
    if (!leadId || !type) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'leadId and type are required');
    }
    const cancelled = await queueService.cancelFollowUp(leadId, type);
    res.json({ data: { cancelled } });
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.post('/snapshot', async (req, res) => {
    try {
      const companyId = req.tenantId;
      const snapshotDate = new Date().toISOString().slice(0, 10);

      const metricsResult = await pool.query(
        `SELECT
          (SELECT jsonb_object_agg(status, cnt) FROM (
            SELECT status, COUNT(*)::int AS cnt
            FROM leads WHERE company_id = $1
            GROUP BY status
          ) s) AS by_status,
          (SELECT jsonb_object_agg(channel, cnt) FROM (
            SELECT channel, COUNT(*)::int AS cnt
            FROM leads WHERE company_id = $1
            GROUP BY channel
          ) c) AS by_channel,
          (SELECT COUNT(*)::int FROM leads WHERE company_id = $1 AND created_at::date = CURRENT_DATE) AS created_today`,
        [companyId]
      );

      const row = metricsResult.rows[0];
      const metrics = {
        by_status: row.by_status ?? {},
        by_channel: row.by_channel ?? {},
        created_today: row.created_today ?? 0,
      };

      const snapshot = await analyticsSnapshotRepository.upsert(companyId, snapshotDate, metrics);

      res.status(201).json({
        snapshot_date: snapshotDate,
        metrics,
        id: snapshot.id,
      });
    } catch (err) {
      errorJson(res, 500, 'INTERNAL_ERROR', err.message);
    }
  }
);

module.exports = router;
