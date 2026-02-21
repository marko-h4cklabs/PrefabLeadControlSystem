/**
 * Analytics repository – aggregates for dashboard.
 * All queries scoped by company_id (tenant).
 * Uses leads, conversations, chat_attachments, company_lead_statuses, chatbot_quote_fields.
 * Legacy: COALESCE(source,'inbox') for null source; channel filter is case-insensitive.
 */

const { pool } = require('../index');

/**
 * Normalize source: all => no filter; inbox/simulation => filter. Legacy: NULL/empty source treated as inbox.
 * @param {string} s - raw source value
 * @returns {{ filter: boolean, value?: string }} - filter=true means add WHERE clause
 */
function normalizeSource(s) {
  const v = (s ?? '').toString().trim().toLowerCase();
  if (!v || v === 'all') return { filter: false };
  if (v === 'inbox' || v === 'simulation') return { filter: true, value: v };
  return { filter: false };
}

/**
 * Normalize channel: all/empty/undefined/all channels => no filter.
 * UI labels like "All Channels" must not be used as filter values.
 * @param {string} c - raw channel value
 * @returns {{ filter: boolean, value?: string }}
 */
function normalizeChannel(c) {
  const v = (c ?? '').toString().trim().toLowerCase();
  if (!v || v === 'all' || v === 'all channels') return { filter: false };
  return { filter: true, value: v };
}

/**
 * Build consistent WHERE clause for analytics (tenant + date range + optional source/channel).
 * Uses PostgreSQL CURRENT_DATE for timestamptz-safe boundaries (avoids Node timezone issues).
 * Legacy: NULL/empty source treated as inbox. Channel filter case-insensitive.
 * @param {string} companyId
 * @param {{ days, startDate?, endDate?, source?, channel? }} options - days preferred for DB; startDate/endDate for response
 * @param {{ withChannelFilter?: boolean }} opts
 */
function buildWhere(companyId, options, opts = {}) {
  const { days = 30, startDate, endDate, source, channel } = options;
  const { withChannelFilter = true } = opts;
  const d = Math.min(365, Math.max(1, parseInt(days, 10) || 30));
  const params = [companyId, d];
  let paramIndex = 3;
  let where = `l.company_id = $1 AND l.created_at >= CURRENT_DATE - ($2::text || ' days')::interval AND l.created_at < CURRENT_DATE + interval '1 day'`;
  const src = normalizeSource(source);
  if (src.filter) {
    where += ` AND COALESCE(NULLIF(TRIM(l.source), ''), 'inbox') = $${paramIndex++}`;
    params.push(src.value);
  }
  const ch = withChannelFilter ? normalizeChannel(channel) : { filter: false };
  if (ch.filter) {
    where += ` AND LOWER(TRIM(l.channel)) = LOWER(TRIM($${paramIndex++}))`;
    params.push(ch.value);
  }
  return { where, params };
}

/** Same as buildWhere but for queries without table alias (plain leads table). */
function buildWhereNoAlias(companyId, options, opts = {}) {
  const { where, params } = buildWhere(companyId, options, opts);
  return { where: where.replace(/l\./g, ''), params };
}

const PRESET_LABELS = {
  budget: 'Budget',
  location: 'Location',
  time_window: 'Time Window',
  email_address: 'Email Address',
  phone_number: 'Phone Number',
  full_name: 'Full Name',
  additional_notes: 'Additional Notes',
  pictures: 'Pictures',
  object_type: 'Object Type',
  doors: 'Doors',
  windows: 'Windows',
  colors: 'Colors',
  dimensions: 'Dimensions',
  roof: 'Roof',
  ground_condition: 'Ground Condition',
  utility_connections: 'Utility Connections',
  completion_level: 'Completion Level',
};

function hasValue(v) {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  return String(v).trim() !== '';
}

function countCollectedFields(parsedFields, quoteSnapshot, hasAttachments) {
  const quoteByName = Object.fromEntries(
    (Array.isArray(quoteSnapshot) ? quoteSnapshot : []).map((f) => [f?.name, f]).filter(([n]) => n)
  );
  const collected = new Set();
  for (const [name, value] of Object.entries(parsedFields ?? {})) {
    if (hasValue(value)) collected.add(name);
  }
  if (hasAttachments && collected.has('pictures') === false) {
    collected.add('pictures');
  }
  return collected;
}

/**
 * Get analytics summary for dashboard.
 * @param {string} companyId
 * @param {{ startDate: string, endDate: string, source?: string, channel?: string }} options
 */
async function getSummary(companyId, options) {
  const { where, params } = buildWhere(companyId, options);

  const [summaryRes, newTodayRes, convRes] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total FROM leads l WHERE ${where}`,
      params
    ),
    pool.query(
      `SELECT COUNT(*)::int AS cnt FROM leads l
       WHERE l.company_id = $1 AND l.created_at >= CURRENT_DATE AND l.created_at < CURRENT_DATE + interval '1 day'`,
      [companyId]
    ),
    pool.query(
      `SELECT COUNT(DISTINCT l.id)::int AS cnt
       FROM leads l
       INNER JOIN conversations c ON c.lead_id = l.id
       WHERE ${where}`,
      params
    ),
  ]);

  const totalLeads = summaryRes.rows[0]?.total ?? 0;
  const newLeadsToday = newTodayRes.rows[0]?.cnt ?? 0;
  const conversationsStarted = convRes.rows[0]?.cnt ?? 0;

  return {
    totalLeads,
    newLeadsToday,
    conversationsStarted,
    quoteDataCompletionRate: null,
    avgCollectedFieldsPerLead: null,
    inboxCount: null,
    simulationCount: null,
    inboxPct: null,
    simulationPct: null,
  };
}

/**
 * Get full summary (with quote completion, inbox/sim split).
 */
async function getFullSummary(companyId, options) {
  const base = await getSummary(companyId, options);
  const { where, params } = buildWhere(companyId, options);

  const [sourceRes, fieldRes] = await Promise.all([
    pool.query(
      `SELECT COALESCE(NULLIF(TRIM(l.source), ''), 'inbox') AS source, COUNT(*)::int AS cnt FROM leads l WHERE ${where} GROUP BY COALESCE(NULLIF(TRIM(l.source), ''), 'inbox')`,
      params
    ),
    pool.query(
      `SELECT l.id, c.parsed_fields, c.quote_snapshot,
              (SELECT COUNT(*) FROM chat_attachments ca WHERE ca.lead_id = l.id AND ca.company_id = l.company_id) AS has_attachments
       FROM leads l
       LEFT JOIN conversations c ON c.lead_id = l.id
       WHERE ${where}`,
      params
    ),
  ]);

  const sourceRows = sourceRes.rows ?? [];
  let inboxCount = 0;
  let simulationCount = 0;
  for (const r of sourceRows) {
    const s = (r.source ?? 'inbox').toLowerCase();
    if (s === 'inbox') inboxCount += r.cnt ?? 0;
    else if (s === 'simulation') simulationCount += r.cnt ?? 0;
  }
  const total = inboxCount + simulationCount;
  base.inboxCount = inboxCount;
  base.simulationCount = simulationCount;
  base.inboxPct = total > 0 ? Math.round((inboxCount / total) * 100) : 0;
  base.simulationPct = total > 0 ? Math.round((simulationCount / total) * 100) : 0;

  const fieldRows = fieldRes.rows ?? [];
  let totalCollected = 0;
  let leadsWithAnyField = 0;
  for (const r of fieldRows) {
    const parsed = r.parsed_fields ?? {};
    const snapshot = r.quote_snapshot ?? [];
    const hasAttachments = (r.has_attachments ?? 0) > 0;
    const collected = countCollectedFields(parsed, snapshot, hasAttachments);
    totalCollected += collected.size;
    if (collected.size > 0) leadsWithAnyField += 1;
  }
  const leadCount = fieldRows.length;
  base.avgCollectedFieldsPerLead = leadCount > 0 ? Math.round((totalCollected / leadCount) * 100) / 100 : 0;
  base.quoteDataCompletionRate = leadCount > 0 ? Math.round((leadsWithAnyField / leadCount) * 100) : 0;

  return base;
}

/**
 * Leads over time (daily buckets).
 */
async function getLeadsOverTime(companyId, options) {
  const { where, params } = buildWhereNoAlias(companyId, options);

  const result = await pool.query(
    `SELECT date_trunc('day', created_at)::date AS day, COALESCE(NULLIF(TRIM(source), ''), 'inbox') AS source, COUNT(*)::int AS count
     FROM leads
     WHERE ${where}
     GROUP BY date_trunc('day', created_at)::date, COALESCE(NULLIF(TRIM(source), ''), 'inbox')
     ORDER BY day ASC`,
    params
  );

  const byDay = {};
  for (const r of result.rows ?? []) {
    const d = r.day ? new Date(r.day).toISOString().slice(0, 10) : null;
    if (!d) continue;
    if (!byDay[d]) byDay[d] = { day: d, inbox: 0, simulation: 0, total: 0 };
    const s = (r.source ?? 'inbox').toLowerCase();
    if (s === 'inbox') byDay[d].inbox += r.count ?? 0;
    else if (s === 'simulation') byDay[d].simulation += r.count ?? 0;
    byDay[d].total += r.count ?? 0;
  }

  return Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * Channel breakdown (count per channel).
 */
async function getChannelBreakdown(companyId, options) {
  const { where, params } = buildWhereNoAlias(companyId, options);

  const result = await pool.query(
    `SELECT COALESCE(TRIM(channel), 'unknown') AS channel, COUNT(*)::int AS count
     FROM leads
     WHERE ${where}
     GROUP BY COALESCE(TRIM(channel), 'unknown')
     ORDER BY count DESC`,
    params
  );

  return (result.rows ?? []).map((r) => ({
    channel: r.channel ?? 'unknown',
    count: r.count ?? 0,
  }));
}

/**
 * Available channels for dropdown (range + source, no channel filter).
 * Returns distinct channel strings sorted alphabetically.
 */
async function getAvailableChannels(companyId, options) {
  const { where, params } = buildWhere(companyId, options, { withChannelFilter: false });
  const result = await pool.query(
    `SELECT DISTINCT COALESCE(TRIM(l.channel), 'unknown') AS channel
     FROM leads l
     WHERE ${where}
     ORDER BY channel ASC`,
    params
  );
  return (result.rows ?? []).map((r) => r.channel ?? 'unknown').filter(Boolean);
}

/**
 * Status breakdown (status_id + company_lead_statuses name, fallback to legacy status).
 */
async function getStatusBreakdown(companyId, options) {
  const { where, params } = buildWhere(companyId, options);

  const result = await pool.query(
    `SELECT COALESCE(cls.name, l.status, 'unknown') AS status_name, COUNT(*)::int AS count
     FROM leads l
     LEFT JOIN company_lead_statuses cls ON l.status_id = cls.id AND cls.company_id = l.company_id
     WHERE ${where}
     GROUP BY COALESCE(cls.name, l.status, 'unknown')
     ORDER BY count DESC`,
    params
  );

  return (result.rows ?? []).map((r) => ({
    status: r.status_name ?? 'unknown',
    count: r.count ?? 0,
  }));
}

/**
 * Raw counts for debugging (ANALYTICS_DEBUG). Total leads for tenant, total after filters.
 */
async function getRawCounts(companyId, options) {
  const totalForTenantRes = await pool.query(
    'SELECT COUNT(*)::int AS cnt FROM leads WHERE company_id = $1',
    [companyId]
  );
  const { where, params } = buildWhere(companyId, options);
  const filteredRes = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM leads l WHERE ${where}`,
    params
  );
  return {
    totalForTenant: totalForTenantRes.rows[0]?.cnt ?? 0,
    totalAfterFilters: filteredRes.rows[0]?.cnt ?? 0,
  };
}

/**
 * Field completion (enabled quote fields: how many leads have each collected).
 */
async function getFieldCompletion(companyId, options) {
  const { where, params } = buildWhere(companyId, options);

  const [enabledRes, leadsRes] = await Promise.all([
    pool.query(
      `SELECT name FROM chatbot_quote_fields WHERE company_id = $1 AND is_enabled = true ORDER BY priority ASC, name ASC`,
      [companyId]
    ),
    pool.query(
      `SELECT l.id, c.parsed_fields, c.quote_snapshot,
              (SELECT COUNT(*) FROM chat_attachments ca WHERE ca.lead_id = l.id AND ca.company_id = l.company_id) AS has_attachments
       FROM leads l
       LEFT JOIN conversations c ON c.lead_id = l.id
       WHERE ${where}`,
      params
    ),
  ]);

  const enabled = (enabledRes.rows ?? []).map((r) => r.name).filter(Boolean);
  const fieldCounts = {};

  for (const lead of leadsRes.rows ?? []) {
    const parsed = lead.parsed_fields ?? {};
    const snapshot = lead.quote_snapshot ?? [];
    const hasAttachments = (lead.has_attachments ?? 0) > 0;
    const collected = countCollectedFields(parsed, snapshot, hasAttachments);
    for (const name of collected) {
      fieldCounts[name] = (fieldCounts[name] ?? 0) + 1;
    }
  }

  const totalLeads = leadsRes.rows?.length ?? 0;
  const out = [];
  for (const name of enabled) {
    const count = fieldCounts[name] ?? 0;
    out.push({
      field: name,
      label: PRESET_LABELS[name] ?? name,
      collected: count,
      total: totalLeads,
      pct: totalLeads > 0 ? Math.round((count / totalLeads) * 100) : 0,
    });
  }

  for (const name of Object.keys(fieldCounts)) {
    if (!enabled.includes(name)) {
      out.push({
        field: name,
        label: PRESET_LABELS[name] ?? name,
        collected: fieldCounts[name],
        total: totalLeads,
        pct: totalLeads > 0 ? Math.round((fieldCounts[name] / totalLeads) * 100) : 0,
      });
    }
  }

  return out.sort((a, b) => b.collected - a.collected);
}

/**
 * Top signals: top channels by conversion to conversation.
 */
async function getTopSignals(companyId, options) {
  const { where, params } = buildWhere(companyId, options);

  const result = await pool.query(
    `SELECT l.channel,
            COUNT(*)::int AS total,
            COUNT(c.id)::int AS with_conversation
     FROM leads l
     LEFT JOIN conversations c ON c.lead_id = l.id
     WHERE ${where}
     GROUP BY l.channel
     ORDER BY with_conversation DESC, total DESC`,
    params
  );

  return (result.rows ?? []).map((r) => ({
    channel: r.channel ?? 'unknown',
    total: r.total ?? 0,
    withConversation: r.with_conversation ?? 0,
    conversionPct: (r.total ?? 0) > 0 ? Math.round(((r.with_conversation ?? 0) / r.total) * 100) : 0,
  }));
}

module.exports = {
  getFullSummary,
  getLeadsOverTime,
  getChannelBreakdown,
  getStatusBreakdown,
  getFieldCompletion,
  getTopSignals,
  getAvailableChannels,
  getRawCounts,
};
