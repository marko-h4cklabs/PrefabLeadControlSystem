const { pool } = require('../index');

const VALID_TYPES = ['text', 'number'];

async function list(companyId) {
  const result = await pool.query(
    'SELECT id, name, type, units, priority, required FROM chatbot_quote_fields WHERE company_id = $1 ORDER BY priority ASC, created_at ASC',
    [companyId]
  );
  return result.rows
    .filter((r) => VALID_TYPES.includes(r.type))
    .map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      units: r.units,
      priority: r.priority,
      required: r.required,
    }));
}

async function replace(companyId, fields) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM chatbot_quote_fields WHERE company_id = $1', [companyId]);
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      await client.query(
        `INSERT INTO chatbot_quote_fields (company_id, name, type, units, priority, required)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          companyId,
          f.name,
          f.type,
          f.units ?? null,
          f.priority ?? 100,
          f.required !== false,
        ]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return list(companyId);
}

module.exports = { list, replace };
