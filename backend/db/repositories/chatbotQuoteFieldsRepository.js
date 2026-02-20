const { pool } = require('../index');

const PRESET_NAMES = [
  'budget',
  'location',
  'email_address',
  'phone_number',
  'full_name',
  'additional_notes',
  'doors',
  'windows',
  'colors',
  'dimensions',
  'roof',
];

function toPresetRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    units: row.units ?? null,
    priority: row.priority ?? 100,
    required: row.required !== false,
    is_enabled: row.is_enabled === true,
    config: row.config ?? {},
  };
}

async function listAllPresets(companyId) {
  const result = await pool.query(
    `SELECT id, name, type, units, priority, required, is_enabled, config
     FROM chatbot_quote_fields
     WHERE company_id = $1 AND name = ANY($2::text[])
     ORDER BY priority ASC, name ASC`,
    [companyId, PRESET_NAMES]
  );
  const rows = result.rows.map(toPresetRow);
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  return PRESET_NAMES.map((name) => byName[name] ?? {
    name,
    type: getPresetType(name),
    units: getPresetUnits(name),
    priority: getPresetPriority(name),
    required: true,
    is_enabled: false,
    config: getDefaultConfig(name),
  });
}

function getPresetType(name) {
  const types = {
    budget: 'number',
    location: 'select_multi',
    email_address: 'text',
    phone_number: 'text',
    full_name: 'text',
    additional_notes: 'text',
    doors: 'select_multi',
    windows: 'select_multi',
    colors: 'select_multi',
    dimensions: 'composite_dimensions',
    roof: 'select_multi',
  };
  return types[name] ?? 'text';
}

function getPresetPriority(name) {
  const priorities = {
    budget: 10,
    location: 20,
    email_address: 30,
    phone_number: 40,
    full_name: 50,
    additional_notes: 60,
    doors: 70,
    windows: 80,
    colors: 90,
    dimensions: 95,
    roof: 100,
  };
  return priorities[name] ?? 100;
}

function getPresetUnits(name) {
  if (name === 'budget') return null;
  if (name === 'dimensions') return 'm';
  return null;
}

function getDefaultConfig(name) {
  if (name === 'budget') return { units: ['EUR', 'USD'], defaultUnit: 'EUR' };
  if (['location', 'doors', 'windows', 'colors', 'roof'].includes(name)) return { options: [] };
  if (name === 'dimensions') return { enabledParts: ['length', 'width', 'height'], unit: 'm' };
  return {};
}

async function updatePresets(companyId, updates) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const { name, is_enabled, config } of updates) {
      if (!PRESET_NAMES.includes(name)) continue;
      const existing = await client.query(
        'SELECT id, is_enabled, config FROM chatbot_quote_fields WHERE company_id = $1 AND name = $2',
        [companyId, name]
      );
      const row = existing.rows[0];
      if (row) {
        const newEnabled = is_enabled !== undefined ? is_enabled : row.is_enabled;
        const newConfig = config !== undefined ? { ...getDefaultConfig(name), ...config } : row.config;
        await client.query(
          'UPDATE chatbot_quote_fields SET is_enabled = $3, config = $4::jsonb WHERE company_id = $1 AND name = $2',
          [companyId, name, newEnabled, JSON.stringify(newConfig)]
        );
      } else {
        const typeVal = getPresetType(name);
        const unitsVal = getPresetUnits(name);
        const priorityVal = getPresetPriority(name);
        const defaultCfg = getDefaultConfig(name);
        const mergedConfig = config !== undefined ? { ...defaultCfg, ...config } : defaultCfg;
        await client.query(
          `INSERT INTO chatbot_quote_fields (company_id, name, type, units, priority, required, is_enabled, config)
           VALUES ($1, $2, $3, $4, $5, true, $6, $7::jsonb)`,
          [companyId, name, typeVal, unitsVal, priorityVal, is_enabled ?? false, JSON.stringify(mergedConfig)]
        );
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return listAllPresets(companyId);
}

async function list(companyId) {
  return listAllPresets(companyId);
}

function getEnabledFields(fields) {
  return (fields ?? []).filter((f) => f?.is_enabled === true);
}

function getFields(companyId) {
  return list(companyId);
}

module.exports = {
  list,
  listAllPresets,
  updatePresets,
  getEnabledFields,
  getFields,
  PRESET_NAMES,
  getPresetType,
  getDefaultConfig,
};
