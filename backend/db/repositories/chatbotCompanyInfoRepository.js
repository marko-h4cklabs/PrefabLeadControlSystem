const { pool } = require('../index');

const DEFAULTS = {
  website_url: '',
  business_description: '',
  additional_notes: '',
};

async function get(companyId, mode = 'autopilot') {
  try {
    const result = await pool.query(
      `SELECT website_url, business_description, additional_notes
       FROM chatbot_company_info WHERE company_id = $1 AND COALESCE(operating_mode, 'autopilot') = $2`,
      [companyId, mode]
    );
    return result.rows[0] ? {
      website_url: result.rows[0].website_url ?? '',
      business_description: result.rows[0].business_description ?? '',
      additional_notes: result.rows[0].additional_notes ?? '',
    } : { ...DEFAULTS };
  } catch (err) {
    if (mode === 'autopilot' && err.message && err.message.includes('operating_mode')) {
      const result = await pool.query(
        `SELECT website_url, business_description, additional_notes
         FROM chatbot_company_info WHERE company_id = $1`,
        [companyId]
      );
      return result.rows[0] ? {
        website_url: result.rows[0].website_url ?? '',
        business_description: result.rows[0].business_description ?? '',
        additional_notes: result.rows[0].additional_notes ?? '',
      } : { ...DEFAULTS };
    }
    throw err;
  }
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

  try {
    await pool.query(
      `INSERT INTO chatbot_company_info (company_id, operating_mode, website_url, business_description, additional_notes, updated_at)
       VALUES ($1, $2, NULL, NULL, NULL, NOW())
       ON CONFLICT (company_id, COALESCE(operating_mode, 'autopilot')) DO UPDATE SET ${updates.join(', ')}`,
      values
    );
  } catch (err) {
    if (mode === 'autopilot' && err.message && err.message.includes('operating_mode')) {
      // Fallback: use original schema without operating_mode
      const fallbackUpdates = [];
      const fallbackValues = [companyId];
      let j = 2;
      if (payload.website_url !== undefined) { fallbackUpdates.push(`website_url = $${j++}`); fallbackValues.push(payload.website_url); }
      if (payload.business_description !== undefined) { fallbackUpdates.push(`business_description = $${j++}`); fallbackValues.push(payload.business_description); }
      if (payload.additional_notes !== undefined) { fallbackUpdates.push(`additional_notes = $${j++}`); fallbackValues.push(payload.additional_notes); }
      fallbackUpdates.push('updated_at = NOW()');
      await pool.query(
        `INSERT INTO chatbot_company_info (company_id, website_url, business_description, additional_notes, updated_at)
         VALUES ($1, NULL, NULL, NULL, NOW())
         ON CONFLICT (company_id) DO UPDATE SET ${fallbackUpdates.join(', ')}`,
        fallbackValues
      );
    } else {
      throw err;
    }
  }
  return get(companyId, mode);
}

module.exports = { get, upsert };
