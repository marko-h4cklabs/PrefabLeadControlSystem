const { pool } = require('../index');

const DEFAULTS = {
  website_url: '',
  business_description: '',
  additional_notes: '',
};

async function get(companyId, mode = 'autopilot') {
  const result = await pool.query(
    `SELECT website_url, business_description, additional_notes
     FROM chatbot_company_info WHERE company_id = $1 AND COALESCE(operating_mode, 'autopilot') = $2`,
    [companyId, mode]
  );
  const row = result.rows[0];
  if (!row) return { ...DEFAULTS };
  return {
    website_url: row.website_url ?? '',
    business_description: row.business_description ?? '',
    additional_notes: row.additional_notes ?? '',
  };
}

async function upsert(companyId, payload, mode = 'autopilot') {
  const updates = [];
  const values = [companyId, mode];
  let i = 3;
  if (payload.website_url !== undefined) {
    updates.push(`website_url = $${i++}`);
    values.push(payload.website_url);
  }
  if (payload.business_description !== undefined) {
    updates.push(`business_description = $${i++}`);
    values.push(payload.business_description);
  }
  if (payload.additional_notes !== undefined) {
    updates.push(`additional_notes = $${i++}`);
    values.push(payload.additional_notes);
  }
  if (updates.length === 0) return get(companyId, mode);
  updates.push('updated_at = NOW()');
  await pool.query(
    `INSERT INTO chatbot_company_info (company_id, operating_mode, website_url, business_description, additional_notes, updated_at)
     VALUES ($1, $2, NULL, NULL, NULL, NOW())
     ON CONFLICT (company_id, COALESCE(operating_mode, 'autopilot')) DO UPDATE SET ${updates.join(', ')}`,
    values
  );
  return get(companyId, mode);
}

module.exports = { get, upsert };
