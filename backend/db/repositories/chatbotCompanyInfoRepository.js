const { pool } = require('../index');

const DEFAULTS = {
  website_url: '',
  business_description: '',
  additional_notes: '',
};

async function get(companyId) {
  const result = await pool.query(
    'SELECT website_url, business_description, additional_notes, last_scrape_requested_at FROM chatbot_company_info WHERE company_id = $1',
    [companyId]
  );
  const row = result.rows[0];
  if (!row) return { ...DEFAULTS, last_scrape_requested_at: null };
  return {
    website_url: row.website_url ?? '',
    business_description: row.business_description ?? '',
    additional_notes: row.additional_notes ?? '',
    last_scrape_requested_at: row.last_scrape_requested_at,
  };
}

async function upsert(companyId, payload) {
  const updates = [];
  const values = [companyId];
  let i = 2;
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
  if (updates.length === 0) return get(companyId);
  updates.push('updated_at = NOW()');
  await pool.query(
    `INSERT INTO chatbot_company_info (company_id, website_url, business_description, additional_notes, updated_at)
     VALUES ($1, NULL, NULL, NULL, NOW())
     ON CONFLICT (company_id) DO UPDATE SET ${updates.join(', ')}`,
    values
  );
  return get(companyId);
}

async function setLastScrapeRequested(companyId) {
  await pool.query(
    `INSERT INTO chatbot_company_info (company_id, last_scrape_requested_at, updated_at)
     VALUES ($1, NOW(), NOW())
     ON CONFLICT (company_id) DO UPDATE SET last_scrape_requested_at = NOW(), updated_at = NOW()`,
    [companyId]
  );
}

async function appendScrapeNote(companyId) {
  const info = await get(companyId);
  const note = `[SCRAPE_REQUESTED at ${new Date().toISOString()}]\n`;
  const newNotes = (info.additional_notes || '') + note;
  await pool.query(
    `INSERT INTO chatbot_company_info (company_id, additional_notes, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (company_id) DO UPDATE SET
       additional_notes = chatbot_company_info.additional_notes || $2,
       last_scrape_requested_at = NOW(),
       updated_at = NOW()`,
    [companyId, note]
  );
}

module.exports = { get, upsert, setLastScrapeRequested, appendScrapeNote };
