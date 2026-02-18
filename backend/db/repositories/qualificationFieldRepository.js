const { pool } = require('../index');

function toPlainField(row) {
  if (!row) return null;
  return {
    id: row.id,
    company_id: row.company_id,
    field_name: row.field_name,
    field_key: row.field_key,
    field_type: row.field_type,
    units: row.units,
    required: row.required ?? false,
    scoring_weight: row.scoring_weight ?? 0,
    dependencies: row.dependencies ?? [],
    validation_rules: row.validation_rules ?? {},
    display_order: row.display_order ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function findById(companyId, fieldId) {
  const result = await pool.query(
    'SELECT * FROM qualification_fields WHERE id = $1 AND company_id = $2',
    [fieldId, companyId]
  );
  return toPlainField(result.rows[0]);
}

async function findAll(companyId) {
  const result = await pool.query(
    'SELECT * FROM qualification_fields WHERE company_id = $1 ORDER BY display_order, field_key',
    [companyId]
  );
  return result.rows.map(toPlainField);
}

async function create(companyId, data) {
  const result = await pool.query(
    `INSERT INTO qualification_fields (company_id, field_name, field_key, field_type, units, required, scoring_weight, dependencies, validation_rules, display_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      companyId,
      data.field_name,
      data.field_key,
      data.field_type,
      data.units ?? null,
      data.required ?? false,
      data.scoring_weight ?? 0,
      JSON.stringify(data.dependencies ?? []),
      JSON.stringify(data.validation_rules ?? {}),
      data.display_order ?? 0,
    ]
  );
  return toPlainField(result.rows[0]);
}

async function update(companyId, fieldId, data) {
  const result = await pool.query(
    `UPDATE qualification_fields SET
       field_name = COALESCE($3, field_name),
       field_key = COALESCE($4, field_key),
       field_type = COALESCE($5, field_type),
       units = COALESCE($6, units),
       required = COALESCE($7, required),
       scoring_weight = COALESCE($8, scoring_weight),
       dependencies = COALESCE($9, dependencies),
       validation_rules = COALESCE($10, validation_rules),
       display_order = COALESCE($11, display_order),
       updated_at = NOW()
     WHERE id = $1 AND company_id = $2
     RETURNING *`,
    [
      fieldId,
      companyId,
      data.field_name,
      data.field_key,
      data.field_type,
      data.units,
      data.required,
      data.scoring_weight,
      data.dependencies != null ? JSON.stringify(data.dependencies) : null,
      data.validation_rules != null ? JSON.stringify(data.validation_rules) : null,
      data.display_order,
    ]
  );
  return toPlainField(result.rows[0]);
}

async function remove(companyId, fieldId) {
  const result = await pool.query(
    'DELETE FROM qualification_fields WHERE id = $1 AND company_id = $2 RETURNING id',
    [fieldId, companyId]
  );
  return result.rowCount > 0;
}

module.exports = {
  findById,
  findAll,
  create,
  update,
  remove,
};
