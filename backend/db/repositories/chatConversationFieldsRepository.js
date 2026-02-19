const { pool } = require('../index');

async function getFields(conversationId, quoteFields = []) {
  const result = await pool.query(
    `SELECT field_name, field_value_text, field_value_number, field_type, updated_at
     FROM chat_conversation_fields
     WHERE conversation_id = $1
     ORDER BY field_name`,
    [conversationId]
  );
  const unitsByField = Object.fromEntries((quoteFields || []).map((f) => [f.name, f.units || null]));
  return result.rows.map((r) => ({
    name: r.field_name,
    type: r.field_type,
    value: r.field_type === 'number' ? (r.field_value_number != null ? Number(r.field_value_number) : null) : r.field_value_text,
    units: unitsByField[r.field_name] ?? null,
  }));
}

async function upsertField(conversationId, fieldName, fieldType, value) {
  const isNumber = fieldType === 'number';
  const valueText = isNumber ? null : (value != null ? String(value) : null);
  const valueNum = isNumber && value != null ? Number(value) : null;

  await pool.query(
    `INSERT INTO chat_conversation_fields (conversation_id, field_name, field_value_text, field_value_number, field_type, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (conversation_id, field_name) DO UPDATE SET
       field_value_text = EXCLUDED.field_value_text,
       field_value_number = EXCLUDED.field_value_number,
       updated_at = NOW()`,
    [conversationId, fieldName, valueText, valueNum, fieldType]
  );
}

module.exports = { getFields, upsertField };
