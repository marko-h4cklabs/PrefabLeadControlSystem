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
  const values = [];
  let i = 1;
  if (payload.website_url !== undefined) {
    updates.push({ col: 'website_url', val: payload.website_url });
  }
  if (payload.business_description !== undefined) {
    updates.push({ col: 'business_description', val: payload.business_description });
  }
  if (payload.additional_notes !== undefined) {
    updates.push({ col: 'additional_notes', val: payload.additional_notes });
  }
  if (updates.length === 0) return get(companyId, mode);

  // Check if row exists for this company+mode
  let exists = false;
  try {
    const check = await pool.query(
      `SELECT 1 FROM chatbot_company_info WHERE company_id = $1 AND COALESCE(operating_mode, 'autopilot') = $2`,
      [companyId, mode]
    );
    exists = check.rows.length > 0;
  } catch (err) {
    if (mode === 'autopilot' && err.message && err.message.includes('operating_mode')) {
      const check = await pool.query(
        `SELECT 1 FROM chatbot_company_info WHERE company_id = $1`,
        [companyId]
      );
      exists = check.rows.length > 0;
    } else {
      throw err;
    }
  }

  if (exists) {
    // UPDATE existing row
    try {
      const setClauses = updates.map((u, idx) => `${u.col} = $${idx + 3}`).join(', ');
      await pool.query(
        `UPDATE chatbot_company_info SET ${setClauses}, updated_at = NOW()
         WHERE company_id = $1 AND COALESCE(operating_mode, 'autopilot') = $2`,
        [companyId, mode, ...updates.map((u) => u.val)]
      );
    } catch (err) {
      if (mode === 'autopilot' && err.message && err.message.includes('operating_mode')) {
        const setClauses = updates.map((u, idx) => `${u.col} = $${idx + 2}`).join(', ');
        await pool.query(
          `UPDATE chatbot_company_info SET ${setClauses}, updated_at = NOW() WHERE company_id = $1`,
          [companyId, ...updates.map((u) => u.val)]
        );
      } else {
        throw err;
      }
    }
  } else {
    // INSERT new row
    try {
      await pool.query(
        `INSERT INTO chatbot_company_info (company_id, operating_mode, website_url, business_description, additional_notes, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [companyId, mode, payload.website_url || null, payload.business_description || null, payload.additional_notes || null]
      );
    } catch (err) {
      if (mode === 'autopilot' && err.message && err.message.includes('operating_mode')) {
        await pool.query(
          `INSERT INTO chatbot_company_info (company_id, website_url, business_description, additional_notes, updated_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [companyId, payload.website_url || null, payload.business_description || null, payload.additional_notes || null]
        );
      } else {
        throw err;
      }
    }
  }
  return get(companyId, mode);
}

module.exports = { get, upsert };
