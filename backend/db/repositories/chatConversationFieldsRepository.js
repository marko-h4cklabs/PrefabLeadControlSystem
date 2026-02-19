const { pool } = require('../index');

async function getFields(conversationId, quoteFields = []) {
  const result = await pool.query(
    `SELECT field_name, field_value_text, field_value_number, field_type, updated_at
     FROM chat_conversation_fields
     WHERE conversation_id = $1
       AND (field_value_text IS NOT NULL AND TRIM(field_value_text) != '' OR field_value_number IS NOT NULL)
     ORDER BY field_name`,
    [conversationId]
  );
  const metaByField = Object.fromEntries((quoteFields || []).map((f) => [f.name, { units: f.units || null, priority: f.priority ?? 100 }]));
  return result.rows.map((r) => {
    const value = r.field_type === 'number'
      ? (r.field_value_number != null ? Number(r.field_value_number) : null)
      : r.field_value_text;
    const meta = metaByField[r.field_name] ?? { units: null, priority: 100 };
    return {
      name: r.field_name,
      type: r.field_type,
      value,
      units: meta.units,
      priority: meta.priority,
    };
  });
}

async function upsertField(conversationId, fieldName, fieldType, value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) {
    return;
  }
  const isNumber = fieldType === 'number';
  const valueText = isNumber ? null : String(value).trim();
  const valueNum = isNumber ? Number(value) : null;
  if (isNumber && Number.isNaN(valueNum)) return;

  await pool.query(
    `INSERT INTO chat_conversation_fields (conversation_id, field_name, field_value_text, field_value_number, field_type, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (conversation_id, field_name) DO UPDATE SET
       field_value_text = COALESCE(NULLIF(TRIM(EXCLUDED.field_value_text), ''), chat_conversation_fields.field_value_text),
       field_value_number = COALESCE(EXCLUDED.field_value_number, chat_conversation_fields.field_value_number),
       updated_at = NOW()`,
    [conversationId, fieldName, valueText, valueNum, fieldType]
  );
}

module.exports = { getFields, upsertField };
