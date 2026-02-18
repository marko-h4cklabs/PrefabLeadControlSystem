const { pool } = require('../index');

function toPlainUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    company_id: row.company_id,
    email: row.email,
    password_hash: row.password_hash,
    role: row.role,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function findById(companyId, userId) {
  const result = await pool.query(
    'SELECT * FROM users WHERE id = $1 AND company_id = $2',
    [userId, companyId]
  );
  return toPlainUser(result.rows[0]);
}

async function findByIdOnly(userId) {
  const result = await pool.query(
    'SELECT * FROM users WHERE id = $1',
    [userId]
  );
  return toPlainUser(result.rows[0]);
}

async function findByEmail(companyId, email) {
  const result = await pool.query(
    'SELECT * FROM users WHERE company_id = $1 AND email = $2',
    [companyId, email]
  );
  return toPlainUser(result.rows[0]);
}

async function findAll(companyId) {
  const result = await pool.query(
    'SELECT * FROM users WHERE company_id = $1 ORDER BY email',
    [companyId]
  );
  return result.rows.map(toPlainUser);
}

async function create(companyId, data) {
  const result = await pool.query(
    `INSERT INTO users (company_id, email, password_hash, role)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [companyId, data.email, data.password_hash, data.role]
  );
  return toPlainUser(result.rows[0]);
}

async function update(companyId, userId, data) {
  const result = await pool.query(
    `UPDATE users SET
       email = COALESCE($3, email),
       password_hash = COALESCE($4, password_hash),
       role = COALESCE($5, role),
       updated_at = NOW()
     WHERE id = $1 AND company_id = $2
     RETURNING *`,
    [userId, companyId, data.email, data.password_hash, data.role]
  );
  return toPlainUser(result.rows[0]);
}

module.exports = {
  findById,
  findByIdOnly,
  findByEmail,
  findAll,
  create,
  update,
};
