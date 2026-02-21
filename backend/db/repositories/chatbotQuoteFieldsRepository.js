const { pool } = require('../index');

const PRESET_NAMES = [
  'budget',
  'location',
  'time_window',
  'email_address',
  'phone_number',
  'full_name',
  'additional_notes',
  'pictures',
  'object_type',
  'doors',
  'windows',
  'colors',
  'dimensions',
  'roof',
  'ground_condition',
  'utility_connections',
  'completion_level',
];

const PRESET_LABELS = {
  budget: 'Budget',
  location: 'Location',
  time_window: 'Time Window',
  email_address: 'Email Address',
  phone_number: 'Phone Number',
  full_name: 'Full Name',
  additional_notes: 'Additional Notes',
  pictures: 'Pictures',
  object_type: 'Object Type',
  doors: 'Doors',
  windows: 'Windows',
  colors: 'Colors',
  dimensions: 'Dimensions',
  roof: 'Roof',
  ground_condition: 'Ground Condition',
  utility_connections: 'Utility Connections',
  completion_level: 'Completion Level',
};

const PRESET_DESCRIPTIONS = {
  budget: 'Budget amount with currency (EUR or USD)',
  location: 'Cities or countries',
  time_window: 'Preferred time window for delivery or installation',
  email_address: 'Valid email address',
  phone_number: 'Phone number',
  full_name: 'Full name',
  additional_notes: 'Additional notes or requirements',
  pictures: 'Can you provide pictures? (yes/no)',
  object_type: 'Type of object or product',
  doors: 'Door options',
  windows: 'Window options',
  colors: 'Color options',
  dimensions: 'Length, width, height with unit',
  roof: 'Roof options',
  ground_condition: 'Ground condition at site',
  utility_connections: 'Utility connections required',
  completion_level: 'Structural phase or fully finished turnkey',
};

function toPresetDto(row, name) {
  const n = name ?? row?.name;
  let config = {};
  if (row?.config != null) {
    if (typeof row.config === 'object' && !Array.isArray(row.config)) {
      config = row.config;
    } else if (typeof row.config === 'string') {
      try {
        config = JSON.parse(row.config) || {};
      } catch {
        config = {};
      }
    }
  }
  const typeVal = row?.type ?? getPresetType(n);
  const unitsVal = row?.units ?? getPresetUnits(n) ?? (config?.defaultUnit ?? config?.unit ?? null);
  return {
    name: n,
    label: PRESET_LABELS[n] ?? n,
    description: PRESET_DESCRIPTIONS[n] ?? '',
    type: typeVal,
    units: unitsVal,
    is_enabled: row?.is_enabled === true,
    config: config ?? {},
    priority: row?.priority ?? getPresetPriority(n),
    required: row?.required !== false,
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
  const byName = Object.fromEntries(result.rows.map((r) => [r.name, r]));
  return PRESET_NAMES.map((name) => {
    const row = byName[name];
    return toPresetDto(row ?? {
      name,
      type: getPresetType(name),
      priority: getPresetPriority(name),
      required: true,
      is_enabled: false,
      config: getDefaultConfig(name),
    }, name);
  });
}

function getPresetType(name) {
  const types = {
    budget: 'number',
    location: 'select_multi',
    time_window: 'select_multi',
    email_address: 'text',
    phone_number: 'text',
    full_name: 'text',
    additional_notes: 'text',
    pictures: 'boolean',
    object_type: 'select_multi',
    doors: 'select_multi',
    windows: 'select_multi',
    colors: 'select_multi',
    dimensions: 'composite_dimensions',
    roof: 'select_multi',
    ground_condition: 'select_multi',
    utility_connections: 'select_multi',
    completion_level: 'select_multi',
  };
  return types[name] ?? 'text';
}

function getPresetPriority(name) {
  const priorities = {
    budget: 10,
    location: 20,
    time_window: 30,
    email_address: 40,
    phone_number: 50,
    full_name: 60,
    additional_notes: 70,
    pictures: 80,
    object_type: 90,
    doors: 200,
    windows: 210,
    colors: 220,
    dimensions: 230,
    roof: 240,
    ground_condition: 250,
    utility_connections: 260,
    completion_level: 270,
  };
  return priorities[name] ?? 300;
}

function getPresetUnits(name) {
  if (name === 'budget') return null;
  if (name === 'dimensions') return 'm';
  return null;
}

function getDefaultConfig(name) {
  if (name === 'budget') return { units: ['EUR', 'USD'], defaultUnit: 'EUR', group: 'basic' };
  if (['location', 'time_window', 'object_type'].includes(name)) return { options: [], group: 'basic' };
  if (['doors', 'windows', 'colors', 'roof', 'ground_condition', 'utility_connections'].includes(name)) return { options: [], group: 'detailed' };
  if (name === 'completion_level') return { options: ['Structural phase', 'Fully finished turnkey'], group: 'detailed' };
  if (name === 'dimensions') return { enabledParts: ['length', 'width', 'height'], unit: 'm', group: 'detailed' };
  if (name === 'pictures') return { group: 'basic' };
  if (['email_address', 'phone_number', 'full_name', 'additional_notes'].includes(name)) return { group: 'basic' };
  return {};
}

async function updatePresets(companyId, updates) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const { name, is_enabled, priority, config } of updates) {
      if (!PRESET_NAMES.includes(name)) continue;
      const existing = await client.query(
        'SELECT id, is_enabled, config, priority FROM chatbot_quote_fields WHERE company_id = $1 AND name = $2',
        [companyId, name]
      );
      const row = existing.rows[0];
      const defaultCfg = getDefaultConfig(name);
      if (row) {
        const newEnabled = is_enabled !== undefined ? is_enabled : row.is_enabled;
        const newConfig = config !== undefined ? { ...defaultCfg, ...config } : row.config;
        const newPriority = priority !== undefined ? priority : (row.priority ?? getPresetPriority(name));
        await client.query(
          'UPDATE chatbot_quote_fields SET is_enabled = $3, config = $4::jsonb, priority = $5 WHERE company_id = $1 AND name = $2',
          [companyId, name, newEnabled, JSON.stringify(newConfig), newPriority]
        );
      } else {
        const typeVal = getPresetType(name);
        const unitsVal = getPresetUnits(name);
        const priorityVal = priority !== undefined ? priority : getPresetPriority(name);
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

function listQuotePresets(companyId) {
  return listAllPresets(companyId);
}

async function upsertQuotePreset(companyId, preset) {
  return updatePresets(companyId, [preset]);
}

async function bulkUpsertQuotePresets(companyId, presets) {
  return updatePresets(companyId, presets);
}

module.exports = {
  list,
  listAllPresets,
  updatePresets,
  listQuotePresets,
  upsertQuotePreset,
  bulkUpsertQuotePresets,
  getEnabledFields,
  getFields,
  PRESET_NAMES,
  getPresetType,
  getDefaultConfig,
};
