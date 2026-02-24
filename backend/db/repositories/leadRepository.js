const { pool } = require('../index');
const conversationRepository = require('./conversationRepository');

function toPlainLead(row, statusRow = null) {
  if (!row) return null;
  const lead = {
    id: row.id,
    company_id: row.company_id,
    channel: row.channel,
    external_id: row.external_id,
    name: row.name ?? null,
    score: row.score ?? 0,
    status: row.status,
    status_id: row.status_id ?? null,
    assigned_sales: row.assigned_sales,
    created_at: row.created_at,
    updated_at: row.updated_at,
    source: row.source ?? 'inbox',
    source_content: row.source_content ?? null,
    source_campaign: row.source_campaign ?? null,
    assigned_setter: row.assigned_setter ?? null,
    assigned_closer: row.assigned_closer ?? null,
    pipeline_stage: row.pipeline_stage ?? null,
    deal_value: row.deal_value != null ? Number(row.deal_value) : null,
    closed_at: row.closed_at ?? null,
  };
  if (statusRow) {
    lead.status_obj = { id: statusRow.id, name: statusRow.name };
    lead.status_name = statusRow.name;
  } else {
    lead.status_name = null;
  }
  return lead;
}

async function findByCompanyChannelExternalId(companyId, channel, externalId, source = null) {
  let sql = 'SELECT * FROM leads WHERE company_id = $1 AND channel = $2 AND external_id = $3';
  const params = [companyId, channel, externalId];
  if (source) {
    sql += ' AND source = $4';
    params.push(source);
  }
  const result = await pool.query(sql, params);
  return toPlainLead(result.rows[0]);
}

async function findById(companyId, leadId) {
  const result = await pool.query(
    `SELECT l.*, cls.id AS status_id_join, cls.name AS status_name
     FROM leads l
     LEFT JOIN company_lead_statuses cls ON l.status_id = cls.id AND cls.company_id = l.company_id
     WHERE l.id = $1 AND l.company_id = $2`,
    [leadId, companyId]
  );
  const r = result.rows[0];
  if (!r) return null;
  const statusRow = r.status_id_join ? { id: r.status_id, name: r.status_name } : null;
  return toPlainLead(
    {
      id: r.id,
      company_id: r.company_id,
      channel: r.channel,
      external_id: r.external_id,
      name: r.name,
      score: r.score,
      status: r.status,
      status_id: r.status_id,
      assigned_sales: r.assigned_sales,
      created_at: r.created_at,
      updated_at: r.updated_at,
      source: r.source ?? 'inbox',
    },
    statusRow
  );
}

function escapeIlikePattern(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

async function findAll(companyId, options = {}) {
  const { status, status_id, query, source, limit = 50, offset = 0 } = options;
  let sql = `SELECT l.*, cls.id AS status_id_join, cls.name AS status_name
    FROM leads l
    LEFT JOIN company_lead_statuses cls ON l.status_id = cls.id AND cls.company_id = l.company_id
    WHERE l.company_id = $1`;
  const params = [companyId];
  let paramIndex = 2;

  if (source) {
    sql += ` AND l.source = $${paramIndex}`;
    params.push(source);
    paramIndex++;
  }
  if (status) {
    sql += ` AND l.status = $${paramIndex}`;
    params.push(status);
    paramIndex++;
  }
  if (status_id) {
    sql += ` AND l.status_id = $${paramIndex}`;
    params.push(status_id);
    paramIndex++;
  }
  if (query && query.trim()) {
    const pattern = '%' + escapeIlikePattern(query.trim()) + '%';
    params.push(pattern);
    sql += ` AND (l.name ILIKE $${paramIndex} OR l.external_id ILIKE $${paramIndex} OR l.channel ILIKE $${paramIndex} OR cls.name ILIKE $${paramIndex})`;
    paramIndex++;
  }

  sql += ' ORDER BY l.created_at DESC';
  sql += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
  params.push(limit, offset);

  let result;
  try {
    result = await pool.query(sql, params);
  } catch (err) {
    console.error('[leadRepository.findAll] SQL error:', err.message, 'params:', params);
    throw err;
  }
  return result.rows.map((r) => {
    const statusRow = r.status_id_join ? { id: r.status_id, name: r.status_name } : null;
    return toPlainLead(
      {
        id: r.id,
        company_id: r.company_id,
        channel: r.channel,
        external_id: r.external_id,
        name: r.name,
        score: r.score,
        status: r.status,
        status_id: r.status_id,
        assigned_sales: r.assigned_sales,
        created_at: r.created_at,
        updated_at: r.updated_at,
        source: r.source ?? 'inbox',
      },
      statusRow
    );
  });
}

async function count(companyId, options = {}) {
  const { status, status_id, query, source } = options;
  if (query && query.trim()) {
    const pattern = '%' + escapeIlikePattern(query.trim()) + '%';
    let sql = `SELECT COUNT(*)::int
      FROM leads l
      LEFT JOIN company_lead_statuses cls ON l.status_id = cls.id AND cls.company_id = l.company_id
      WHERE l.company_id = $1
        AND (l.name ILIKE $2 OR l.external_id ILIKE $2 OR l.channel ILIKE $2 OR cls.name ILIKE $2)`;
    const params = [companyId, pattern];
    let paramIndex = 3;
    if (source) {
      sql += ` AND l.source = $${paramIndex++}`;
      params.push(source);
    }
    if (status) {
      sql += ` AND l.status = $${paramIndex++}`;
      params.push(status);
    }
    if (status_id) {
      sql += ` AND l.status_id = $${paramIndex++}`;
      params.push(status_id);
    }
    try {
      const result = await pool.query(sql, params);
      return result.rows[0]?.count ?? 0;
    } catch (err) {
      console.error('[leadRepository.count] SQL error:', err.message, 'params:', params);
      throw err;
    }
  }
  let sql = 'SELECT COUNT(*)::int FROM leads WHERE company_id = $1';
  const params = [companyId];
  let paramIndex = 2;
  if (source) {
    sql += ` AND source = $${paramIndex++}`;
    params.push(source);
  }
  if (status) {
    sql += ` AND status = $${paramIndex++}`;
    params.push(status);
  }
  if (status_id) {
    sql += ` AND status_id = $${paramIndex++}`;
    params.push(status_id);
  }
  try {
    const result = await pool.query(sql, params);
    return result.rows[0]?.count ?? 0;
  } catch (err) {
    console.error('[leadRepository.count] SQL error:', err.message, 'params:', params);
    throw err;
  }
}

async function create(companyId, data) {
  const defaultStatusResult = await pool.query(
    `SELECT id FROM company_lead_statuses WHERE company_id = $1 AND is_default = true LIMIT 1`,
    [companyId]
  );
  const defaultStatusId = defaultStatusResult.rows[0]?.id ?? null;

  const nameVal = data.name ?? data.external_id ?? null;
  const externalIdVal = data.external_id ?? data.name ?? null;
  const sourceVal = data.source === 'simulation' ? 'simulation' : 'inbox';
  const result = await pool.query(
    `INSERT INTO leads (company_id, channel, external_id, name, score, status, status_id, assigned_sales, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      companyId,
      data.channel,
      externalIdVal,
      nameVal,
      data.score ?? 0,
      data.status ?? 'new',
      data.status_id ?? defaultStatusId,
      data.assigned_sales ?? null,
      sourceVal,
    ]
  );
  const row = result.rows[0];
  if (row && !row.status_id && defaultStatusId) {
    await pool.query('UPDATE leads SET status_id = $1 WHERE id = $2', [defaultStatusId, row.id]);
    row.status_id = defaultStatusId;
  }
  const statusRow = row?.status_id ? await pool.query(
    'SELECT id, name FROM company_lead_statuses WHERE id = $1',
    [row.status_id]
  ).then((r) => r.rows[0]) : null;
  return toPlainLead(row, statusRow);
}

async function update(companyId, leadId, data) {
  const updates = [];
  const params = [leadId, companyId];
  let paramIndex = 3;
  if (data.channel !== undefined) {
    updates.push(`channel = $${paramIndex++}`);
    params.push(data.channel);
  }
  if (data.external_id !== undefined) {
    updates.push(`external_id = $${paramIndex++}`);
    params.push(data.external_id);
  }
  if (data.score !== undefined) {
    updates.push(`score = $${paramIndex++}`);
    params.push(data.score);
  }
  if (data.status !== undefined) {
    updates.push(`status = $${paramIndex++}`);
    params.push(data.status);
  }
  if (data.status_id !== undefined) {
    updates.push(`status_id = $${paramIndex++}`);
    params.push(data.status_id);
  }
  if (data.assigned_sales !== undefined) {
    updates.push(`assigned_sales = $${paramIndex++}`);
    params.push(data.assigned_sales);
  }
  if (data.name !== undefined) {
    updates.push(`name = $${paramIndex++}`);
    params.push(data.name);
  }
  if (data.source_content !== undefined) {
    updates.push(`source_content = $${paramIndex++}`);
    params.push(data.source_content);
  }
  if (data.source_campaign !== undefined) {
    updates.push(`source_campaign = $${paramIndex++}`);
    params.push(data.source_campaign);
  }
  if (data.assigned_setter !== undefined) {
    updates.push(`assigned_setter = $${paramIndex++}`);
    params.push(data.assigned_setter);
  }
  if (data.assigned_closer !== undefined) {
    updates.push(`assigned_closer = $${paramIndex++}`);
    params.push(data.assigned_closer);
  }
  if (data.pipeline_stage !== undefined) {
    updates.push(`pipeline_stage = $${paramIndex++}`);
    params.push(data.pipeline_stage);
  }
  if (data.deal_value !== undefined) {
    updates.push(`deal_value = $${paramIndex++}`);
    params.push(data.deal_value);
  }
  if (data.closed_at !== undefined) {
    updates.push(`closed_at = $${paramIndex++}`);
    params.push(data.closed_at);
  }
  if (updates.length === 0) {
    const existing = await findById(companyId, leadId);
    return existing;
  }
  updates.push('updated_at = NOW()');
  const result = await pool.query(
    `UPDATE leads SET ${updates.join(', ')} WHERE id = $1 AND company_id = $2 RETURNING *`,
    params
  );
  const row = result.rows[0];
  if (!row) return null;
  const statusRow = row.status_id ? await pool.query(
    'SELECT id, name FROM company_lead_statuses WHERE id = $1',
    [row.status_id]
  ).then((r) => r.rows[0]) : null;
  return toPlainLead(row, statusRow);
}

async function setStatus(companyId, leadId, statusId) {
  const statusRow = await pool.query(
    'SELECT id, name FROM company_lead_statuses WHERE id = $1 AND company_id = $2',
    [statusId, companyId]
  );
  if (!statusRow.rows[0]) return null;
  const result = await pool.query(
    `UPDATE leads SET status_id = $1, updated_at = NOW() WHERE id = $2 AND company_id = $3 RETURNING *`,
    [statusId, leadId, companyId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return toPlainLead(row, statusRow.rows[0]);
}

async function getCollectedInfoSummary(leadId, maxLen = 120) {
  const conversation = await conversationRepository.getByLeadId(leadId);
  const parsed = conversation?.parsed_fields ?? {};
  const snapshot = conversation?.quote_snapshot ?? [];
  const ordered = Array.isArray(snapshot) ? snapshot : [];
  const quoteByName = Object.fromEntries(ordered.map((f) => [f.name, f]));
  const parts = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (value == null || String(value).trim() === '') continue;
    const qf = quoteByName[name];
    const units = qf?.units ? ` ${qf.units}` : '';
    parts.push(`${name}: ${value}${units}`);
    if (parts.join(' · ').length > maxLen) break;
  }
  const summary = parts.join(' · ');
  return summary.length > maxLen ? summary.slice(0, maxLen - 3) + '...' : summary;
}

async function touchUpdatedAt(companyId, leadId) {
  await pool.query(
    'UPDATE leads SET updated_at = NOW() WHERE id = $1 AND company_id = $2',
    [leadId, companyId]
  );
}

async function setName(companyId, leadId, name) {
  const result = await pool.query(
    `UPDATE leads SET name = $1, updated_at = NOW() WHERE id = $2 AND company_id = $3 RETURNING *`,
    [name, leadId, companyId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const statusRow = row.status_id ? await pool.query(
    'SELECT id, name FROM company_lead_statuses WHERE id = $1',
    [row.status_id]
  ).then((r) => r.rows[0]) : null;
  return toPlainLead(row, statusRow);
}

module.exports = {
  findById,
  findAll,
  count,
  create,
  update,
  setStatus,
  setName,
  touchUpdatedAt,
  getCollectedInfoSummary,
  findByCompanyChannelExternalId,
};
