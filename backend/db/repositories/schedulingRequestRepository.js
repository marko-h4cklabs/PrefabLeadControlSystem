const { pool } = require('../index');

const SELECT_COLS = `
  sr.id, sr.company_id, sr.lead_id, sr.conversation_id,
  sr.source, sr.status, sr.request_type,
  sr.preferred_date, sr.preferred_time, sr.preferred_time_window,
  sr.preferred_timezone, sr.availability_mode,
  sr.selected_slot_start_at, sr.selected_slot_end_at,
  sr.notes, sr.metadata,
  sr.converted_appointment_id, sr.created_by_user_id,
  sr.created_at, sr.updated_at,
  l.name AS lead_name, l.channel AS lead_channel,
  COALESCE(cls.name, l.status) AS lead_status
`;

const FROM_JOINED = `
  FROM scheduling_requests sr
  LEFT JOIN leads l ON sr.lead_id = l.id
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
    companyId: row.company_id,
    leadId: row.lead_id,
    lead: leadObj,
    conversationId: row.conversation_id ?? null,
    source: row.source,
    status: row.status,
    requestType: row.request_type,
    preferredDate: row.preferred_date ?? null,
    preferredTime: row.preferred_time ?? null,
    preferredTimeWindow: row.preferred_time_window ?? {},
    preferredTimezone: row.preferred_timezone ?? 'Europe/Zagreb',
    availabilityMode: row.availability_mode ?? 'manual',
    selectedSlotStartAt: row.selected_slot_start_at ?? null,
    selectedSlotEndAt: row.selected_slot_end_at ?? null,
    notes: row.notes ?? null,
    metadata: row.metadata ?? {},
    convertedAppointmentId: row.converted_appointment_id ?? null,
    createdByUserId: row.created_by_user_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function create(data) {
  const result = await pool.query(
    `INSERT INTO scheduling_requests
       (company_id, lead_id, conversation_id, source, status, request_type,
        preferred_date, preferred_time, preferred_time_window, preferred_timezone,
        availability_mode, selected_slot_start_at, selected_slot_end_at,
        notes, metadata, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15::jsonb,$16)
     RETURNING id`,
    [
      data.companyId,
      data.leadId,
      data.conversationId ?? null,
      data.source ?? 'chatbot',
      data.status ?? 'open',
      data.requestType ?? 'call',
      data.preferredDate ?? null,
      data.preferredTime ?? null,
      JSON.stringify(data.preferredTimeWindow ?? {}),
      data.preferredTimezone ?? 'Europe/Zagreb',
      data.availabilityMode ?? 'manual',
      data.selectedSlotStartAt ?? null,
      data.selectedSlotEndAt ?? null,
      data.notes ?? null,
      JSON.stringify(data.metadata ?? {}),
      data.createdByUserId ?? null,
    ]
  );
  return findById(data.companyId, result.rows[0].id);
}

async function findById(companyId, id) {
  const result = await pool.query(
    `SELECT ${SELECT_COLS} ${FROM_JOINED} WHERE sr.company_id = $1 AND sr.id = $2`,
    [companyId, id]
  );
  return toDto(result.rows[0]);
}

async function update(companyId, id, patch) {
  const fields = [];
  const values = [id, companyId];
  let idx = 3;
  const allowed = {
    status: 'status',
    request_type: 'request_type',
    preferred_date: 'preferred_date',
    preferred_time: 'preferred_time',
    preferred_time_window: { col: 'preferred_time_window', cast: '::jsonb' },
    preferred_timezone: 'preferred_timezone',
    availability_mode: 'availability_mode',
    selected_slot_start_at: 'selected_slot_start_at',
    selected_slot_end_at: 'selected_slot_end_at',
    notes: 'notes',
    metadata: { col: 'metadata', cast: '::jsonb' },
    converted_appointment_id: 'converted_appointment_id',
  };
  for (const [key, spec] of Object.entries(allowed)) {
    if (patch[key] !== undefined) {
      const col = typeof spec === 'string' ? spec : spec.col;
      const cast = typeof spec === 'object' ? spec.cast : '';
      fields.push(`${col} = $${idx}${cast}`);
      const val = cast === '::jsonb' ? JSON.stringify(patch[key]) : patch[key];
      values.push(val);
      idx++;
    }
  }
  if (fields.length === 0) return findById(companyId, id);
  fields.push('updated_at = NOW()');
  const result = await pool.query(
    `UPDATE scheduling_requests SET ${fields.join(', ')} WHERE id = $1 AND company_id = $2 RETURNING id`,
    values
  );
  if (!result.rows[0]) return null;
  return findById(companyId, id);
}

async function list(companyId, options = {}) {
  const { status, leadId, requestType, limit = 50, offset = 0 } = options;
  let sql = `SELECT ${SELECT_COLS} ${FROM_JOINED} WHERE sr.company_id = $1`;
  const params = [companyId];
  let idx = 2;
  if (status) { sql += ` AND sr.status = $${idx++}`; params.push(status); }
  if (leadId) { sql += ` AND sr.lead_id = $${idx++}`; params.push(leadId); }
  if (requestType) { sql += ` AND sr.request_type = $${idx++}`; params.push(requestType); }
  sql += ` ORDER BY sr.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
  params.push(Math.min(limit, 200), Math.max(offset, 0));
  const result = await pool.query(sql, params);
  return (result.rows ?? []).map(toDto);
}

async function count(companyId, options = {}) {
  const { status, leadId, requestType } = options;
  let sql = `SELECT COUNT(*)::int AS cnt FROM scheduling_requests sr WHERE sr.company_id = $1`;
  const params = [companyId];
  let idx = 2;
  if (status) { sql += ` AND sr.status = $${idx++}`; params.push(status); }
  if (leadId) { sql += ` AND sr.lead_id = $${idx++}`; params.push(leadId); }
  if (requestType) { sql += ` AND sr.request_type = $${idx++}`; params.push(requestType); }
  const result = await pool.query(sql, params);
  return result.rows[0]?.cnt ?? 0;
}

module.exports = { create, findById, update, list, count };
