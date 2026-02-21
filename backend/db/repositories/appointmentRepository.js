const { pool } = require('../index');

const SELECT_COLS = `
  a.id, a.company_id, a.lead_id, a.title, a.appointment_type, a.status,
  a.start_at, a.end_at, a.timezone, a.notes, a.source,
  a.reminder_minutes_before, a.created_by_user_id,
  a.created_at, a.updated_at,
  l.name AS lead_name, l.channel AS lead_channel,
  COALESCE(cls.name, l.status) AS lead_status
`;

const FROM_JOINED = `
  FROM appointments a
  LEFT JOIN leads l ON a.lead_id = l.id
  LEFT JOIN company_lead_statuses cls ON l.status_id = cls.id AND cls.company_id = l.company_id
`;

function toDto(row) {
  if (!row) return null;
  const leadObj = row.lead_name != null || row.lead_channel != null ? {
    id: row.lead_id,
    name: row.lead_name ?? null,
    channel: row.lead_channel ?? null,
    status: row.lead_status ?? null,
  } : null;
  return {
    id: row.id,
    // snake_case
    company_id: row.company_id,
    lead_id: row.lead_id,
    appointment_type: row.appointment_type ?? 'call',
    start_at: row.start_at ?? null,
    end_at: row.end_at ?? null,
    reminder_minutes_before: row.reminder_minutes_before ?? null,
    created_by_user_id: row.created_by_user_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    // camelCase
    companyId: row.company_id,
    leadId: row.lead_id,
    appointmentType: row.appointment_type ?? 'call',
    startAt: row.start_at ?? null,
    endAt: row.end_at ?? null,
    reminderMinutesBefore: row.reminder_minutes_before ?? null,
    createdByUserId: row.created_by_user_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // shared (already single-word)
    lead: leadObj,
    title: row.title ?? null,
    status: row.status ?? 'scheduled',
    timezone: row.timezone ?? 'Europe/Zagreb',
    notes: row.notes ?? null,
    source: row.source ?? 'manual',
  };
}

async function create(data) {
  const {
    companyId, leadId, title, appointmentType = 'call', status = 'scheduled',
    startAt, endAt, timezone = 'Europe/Zagreb', notes = null,
    source = 'manual', reminderMinutesBefore = null, createdByUserId = null,
  } = data;
  const result = await pool.query(
    `INSERT INTO appointments
       (company_id, lead_id, title, appointment_type, status, start_at, end_at, timezone, notes, source, reminder_minutes_before, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [companyId, leadId, title, appointmentType, status, startAt, endAt, timezone, notes, source, reminderMinutesBefore, createdByUserId]
  );
  return findById(companyId, result.rows[0].id);
}

async function findById(companyId, id) {
  const result = await pool.query(
    `SELECT ${SELECT_COLS} ${FROM_JOINED} WHERE a.company_id = $1 AND a.id = $2`,
    [companyId, id]
  );
  return toDto(result.rows[0]);
}

async function update(companyId, id, patch) {
  const fields = [];
  const values = [id, companyId];
  let idx = 3;
  const allowed = ['title', 'appointment_type', 'status', 'start_at', 'end_at', 'timezone', 'notes', 'source', 'reminder_minutes_before'];
  for (const key of allowed) {
    if (patch[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      values.push(patch[key]);
    }
  }
  if (fields.length === 0) return findById(companyId, id);
  fields.push('updated_at = NOW()');
  const result = await pool.query(
    `UPDATE appointments SET ${fields.join(', ')} WHERE id = $1 AND company_id = $2 RETURNING id`,
    values
  );
  if (!result.rows[0]) return null;
  return findById(companyId, id);
}

async function list(companyId, options = {}) {
  const { from, to, status, appointmentType, source, leadId, limit = 100, offset = 0 } = options;
  let sql = `SELECT ${SELECT_COLS} ${FROM_JOINED} WHERE a.company_id = $1`;
  const params = [companyId];
  let idx = 2;
  if (from) { sql += ` AND a.start_at >= $${idx++}::timestamptz`; params.push(from); }
  if (to) { sql += ` AND a.start_at < $${idx++}::timestamptz`; params.push(to); }
  if (status) { sql += ` AND a.status = $${idx++}`; params.push(status); }
  if (appointmentType) { sql += ` AND a.appointment_type = $${idx++}`; params.push(appointmentType); }
  if (source && source !== 'all') { sql += ` AND a.source = $${idx++}`; params.push(source); }
  if (leadId) { sql += ` AND a.lead_id = $${idx++}`; params.push(leadId); }
  sql += ` ORDER BY a.start_at ASC NULLS LAST LIMIT $${idx++} OFFSET $${idx++}`;
  params.push(Math.min(limit, 500), Math.max(offset, 0));
  const result = await pool.query(sql, params);
  return (result.rows ?? []).map(toDto);
}

async function count(companyId, options = {}) {
  const { from, to, status, appointmentType, source, leadId } = options;
  let sql = `SELECT COUNT(*)::int AS cnt FROM appointments a WHERE a.company_id = $1`;
  const params = [companyId];
  let idx = 2;
  if (from) { sql += ` AND a.start_at >= $${idx++}::timestamptz`; params.push(from); }
  if (to) { sql += ` AND a.start_at < $${idx++}::timestamptz`; params.push(to); }
  if (status) { sql += ` AND a.status = $${idx++}`; params.push(status); }
  if (appointmentType) { sql += ` AND a.appointment_type = $${idx++}`; params.push(appointmentType); }
  if (source && source !== 'all') { sql += ` AND a.source = $${idx++}`; params.push(source); }
  if (leadId) { sql += ` AND a.lead_id = $${idx++}`; params.push(leadId); }
  const result = await pool.query(sql, params);
  return result.rows[0]?.cnt ?? 0;
}

async function upcoming(companyId, { limit = 10, withinDays = 30 } = {}) {
  const days = Math.max(1, Math.min(365, parseInt(withinDays, 10) || 30));
  const result = await pool.query(
    `SELECT ${SELECT_COLS} ${FROM_JOINED}
     WHERE a.company_id = $1
       AND a.status = 'scheduled'
       AND a.start_at >= NOW()
       AND a.start_at < NOW() + make_interval(days => $2)
     ORDER BY a.start_at ASC
     LIMIT $3`,
    [companyId, days, Math.min(limit, 100)]
  );
  return (result.rows ?? []).map(toDto);
}

async function cancel(companyId, id, cancellationNote = null) {
  const existing = await findById(companyId, id);
  if (!existing) return null;
  const notes = cancellationNote
    ? [existing.notes, `Cancelled: ${cancellationNote}`].filter(Boolean).join('\n')
    : existing.notes;
  return update(companyId, id, { status: 'cancelled', notes });
}

module.exports = { create, findById, update, list, count, upcoming, cancel };
