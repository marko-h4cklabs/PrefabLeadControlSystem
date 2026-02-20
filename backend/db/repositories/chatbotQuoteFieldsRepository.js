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

const PRESET_LABELS = {
  budget: 'Budget',
  location: 'Location',
  email_address: 'Email Address',
  phone_number: 'Phone Number',
  full_name: 'Full Name',
  additional_notes: 'Additional Notes',
  doors: 'Doors',
  windows: 'Windows',
  colors: 'Colors',
  dimensions: 'Dimensions',
  roof: 'Roof',
};

const PRESET_DESCRIPTIONS = {
  budget: 'Budget amount with currency (EUR or USD)',
  location: 'Cities or countries',
  email_address: 'Valid email address',
  phone_number: 'Phone number',
  full_name: 'Full name',
  additional_notes: 'Additional notes or requirements',
  doors: 'Door options',
  windows: 'Window options',
  colors: 'Color options',
  dimensions: 'Length, width, height with unit',
  roof: 'Roof options',
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
