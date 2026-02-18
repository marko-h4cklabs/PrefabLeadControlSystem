const { pool } = require('../index');

function toPlainCompany(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    contact_email: row.contact_email,
    contact_phone: row.contact_phone,
    chatbot_style: row.chatbot_style ?? {},
    scoring_config: row.scoring_config ?? {},
    channels_enabled: row.channels_enabled ?? [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function findById(id) {
  const result = await pool.query(
    'SELECT * FROM companies WHERE id = $1',
    [id]
  );
  return toPlainCompany(result.rows[0]);
}

async function findAll() {
  const result = await pool.query(
    'SELECT * FROM companies ORDER BY name'
  );
  return result.rows.map(toPlainCompany);
}

async function create(data) {
  const result = await pool.query(
    `INSERT INTO companies (name, contact_email, contact_phone, chatbot_style, scoring_config, channels_enabled)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      data.name,
      data.contact_email ?? null,
      data.contact_phone ?? null,
      JSON.stringify(data.chatbot_style ?? {}),
      JSON.stringify(data.scoring_config ?? {}),
      JSON.stringify(data.channels_enabled ?? []),
    ]
  );
  return toPlainCompany(result.rows[0]);
}

async function update(id, data) {
  const result = await pool.query(
    `UPDATE companies SET
       name = COALESCE($2, name),
       contact_email = COALESCE($3, contact_email),
       contact_phone = COALESCE($4, contact_phone),
       chatbot_style = COALESCE($5, chatbot_style),
       scoring_config = COALESCE($6, scoring_config),
       channels_enabled = COALESCE($7, channels_enabled),
       updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      id,
      data.name,
      data.contact_email,
      data.contact_phone,
      data.chatbot_style != null ? JSON.stringify(data.chatbot_style) : null,
      data.scoring_config != null ? JSON.stringify(data.scoring_config) : null,
      data.channels_enabled != null ? JSON.stringify(data.channels_enabled) : null,
    ]
  );
  return toPlainCompany(result.rows[0]);
}

module.exports = {
  findById,
  findAll,
  create,
  update,
};
