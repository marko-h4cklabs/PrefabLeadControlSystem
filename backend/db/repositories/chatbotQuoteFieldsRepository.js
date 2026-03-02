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

function sanitizeVariableName(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .substring(0, 50);
}

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
    id: row?.id ?? null,
    name: n,
    label: PRESET_LABELS[n] ?? n,
    description: PRESET_DESCRIPTIONS[n] ?? '',
    type: typeVal,
    units: unitsVal,
    is_enabled: row?.is_enabled === true,
    config: config ?? {},
    priority: row?.priority ?? getPresetPriority(n),
    required: row?.required !== false,
    is_custom: false,
    variable_name: row?.variable_name ?? sanitizeVariableName(n),
    field_type: typeVal,
    qualification_prompt: row?.qualification_prompt ?? null,
  };
}

async function listAllPresets(companyId, mode = 'autopilot') {
  let result;
  try {
    result = await pool.query(
      `SELECT id, name, type, units, priority, required, is_enabled, config, qualification_prompt
       FROM chatbot_quote_fields
       WHERE company_id = $1 AND name = ANY($2::text[]) AND COALESCE(operating_mode, 'autopilot') = $3
       ORDER BY priority ASC, name ASC`,
      [companyId, PRESET_NAMES, mode]
    );
  } catch (err) {
    if (mode === 'autopilot' && err.message && err.message.includes('operating_mode')) {
      result = await pool.query(
        `SELECT id, name, type, units, priority, required, is_enabled, config, qualification_prompt
         FROM chatbot_quote_fields
         WHERE company_id = $1 AND name = ANY($2::text[])
         ORDER BY priority ASC, name ASC`,
        [companyId, PRESET_NAMES]
      );
    } else {
      throw err;
    }
  }
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
    pictures: 'pictures',
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

async function updatePresets(companyId, updates, mode = 'autopilot') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let useFallback = false;
    for (const { name, is_enabled, priority, config, qualification_prompt } of updates) {
      if (!PRESET_NAMES.includes(name)) continue;
      let existing;
      if (!useFallback) {
        try {
          existing = await client.query(
            'SELECT id, is_enabled, config, priority, qualification_prompt FROM chatbot_quote_fields WHERE company_id = $1 AND name = $2 AND COALESCE(operating_mode, \'autopilot\') = $3',
            [companyId, name, mode]
          );
        } catch (colErr) {
          if (mode === 'autopilot' && colErr.message && colErr.message.includes('operating_mode')) {
            useFallback = true;
            existing = await client.query(
              'SELECT id, is_enabled, config, priority, qualification_prompt FROM chatbot_quote_fields WHERE company_id = $1 AND name = $2',
              [companyId, name]
            );
          } else {
            throw colErr;
          }
        }
      } else {
        existing = await client.query(
          'SELECT id, is_enabled, config, priority, qualification_prompt FROM chatbot_quote_fields WHERE company_id = $1 AND name = $2',
          [companyId, name]
        );
      }
      const row = existing.rows[0];
      const defaultCfg = getDefaultConfig(name);
      if (row) {
        const newEnabled = is_enabled !== undefined ? is_enabled : row.is_enabled;
        const newConfig = config !== undefined ? { ...defaultCfg, ...config } : row.config;
        const newPriority = priority !== undefined ? priority : (row.priority ?? getPresetPriority(name));
        const newQualPrompt = qualification_prompt !== undefined ? (qualification_prompt || null) : (row.qualification_prompt ?? null);
        if (useFallback) {
          await client.query(
            `UPDATE chatbot_quote_fields SET is_enabled = $3, config = $4::jsonb, priority = $5, qualification_prompt = $6
             WHERE company_id = $1 AND name = $2`,
            [companyId, name, newEnabled, JSON.stringify(newConfig), newPriority, newQualPrompt]
          );
        } else {
          await client.query(
            `UPDATE chatbot_quote_fields SET is_enabled = $4, config = $5::jsonb, priority = $6, qualification_prompt = $7
             WHERE company_id = $1 AND name = $2 AND COALESCE(operating_mode, 'autopilot') = $3`,
            [companyId, name, mode, newEnabled, JSON.stringify(newConfig), newPriority, newQualPrompt]
          );
        }
      } else {
        const typeVal = getPresetType(name);
        const unitsVal = getPresetUnits(name);
        const priorityVal = priority !== undefined ? priority : getPresetPriority(name);
        const mergedConfig = config !== undefined ? { ...defaultCfg, ...config } : defaultCfg;
        const qualPrompt = qualification_prompt || null;
        if (useFallback) {
          await client.query(
            `INSERT INTO chatbot_quote_fields (company_id, name, type, units, priority, required, is_enabled, config, qualification_prompt)
             VALUES ($1, $2, $3, $4, $5, true, $6, $7::jsonb, $8)`,
            [companyId, name, typeVal, unitsVal, priorityVal, is_enabled ?? false, JSON.stringify(mergedConfig), qualPrompt]
          );
        } else {
          await client.query(
            `INSERT INTO chatbot_quote_fields (company_id, name, type, units, priority, required, is_enabled, config, qualification_prompt, operating_mode)
             VALUES ($1, $2, $3, $4, $5, true, $6, $7::jsonb, $8, $9)`,
            [companyId, name, typeVal, unitsVal, priorityVal, is_enabled ?? false, JSON.stringify(mergedConfig), qualPrompt, mode]
          );
        }
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return listAllPresets(companyId, mode);
}

/**
 * List all fields for a given operating mode.
 * For 'copilot' mode, returns custom copilot fields (created via settings UI).
 * For 'autopilot' mode, returns preset fields.
 */
async function list(companyId, mode = 'autopilot') {
  if (mode === 'copilot') {
    return listCopilotFields(companyId);
  }
  return listAllPresets(companyId, mode);
}

/**
 * Returns all copilot-mode fields (custom fields created via copilot settings).
 */
async function listCopilotFields(companyId) {
  let result;
  try {
    result = await pool.query(
      `SELECT id, name, label, type, field_type, units, priority, required, is_enabled, config,
              is_custom, variable_name, qualification_prompt
       FROM chatbot_quote_fields
       WHERE company_id = $1 AND COALESCE(operating_mode, 'autopilot') = 'copilot'
       ORDER BY priority ASC, name ASC`,
      [companyId]
    );
  } catch (colErr) {
    if (colErr.message && colErr.message.includes('operating_mode')) {
      result = await pool.query(
        `SELECT id, name, label, type, field_type, units, priority, required, is_enabled, config,
                is_custom, variable_name, qualification_prompt
         FROM chatbot_quote_fields
         WHERE company_id = $1 AND is_custom = true
         ORDER BY priority ASC, name ASC`,
        [companyId]
      );
    } else {
      throw colErr;
    }
  }
  return (result.rows || []).map((row) => {
    let config = {};
    if (row.config != null) {
      if (typeof row.config === 'object' && !Array.isArray(row.config)) config = row.config;
      else if (typeof row.config === 'string') {
        try { config = JSON.parse(row.config) || {}; } catch { config = {}; }
      }
    }
    const typeVal = row.field_type || row.type || 'text';
    return {
      id: row.id,
      name: row.variable_name || row.name,
      label: row.label || row.name || row.variable_name || '',
      description: '',
      type: typeVal,
      units: row.units ?? null,
      is_enabled: row.is_enabled === true,
      config,
      priority: row.priority ?? 500,
      required: row.required !== false,
      is_custom: row.is_custom === true,
      variable_name: row.variable_name || row.name,
      field_type: typeVal,
      qualification_prompt: row.qualification_prompt ?? null,
    };
  });
}

async function listCustomFields(companyId) {
  const result = await pool.query(
    `SELECT id, name, type, units, priority, required, is_enabled, config, variable_name, field_type, label, qualification_prompt
     FROM chatbot_quote_fields
     WHERE company_id = $1 AND is_custom = true
     ORDER BY priority ASC, name ASC`,
    [companyId]
  );
  return (result.rows || []).map((row) => {
    let config = {};
    if (row.config != null) {
      if (typeof row.config === 'object' && !Array.isArray(row.config)) config = row.config;
      else if (typeof row.config === 'string') {
        try {
          config = JSON.parse(row.config) || {};
        } catch {
          config = {};
        }
      }
    }
    const typeVal = row.field_type || row.type || 'text';
    return {
      id: row.id,
      name: row.variable_name || row.name,
      label: row.label || row.name || row.variable_name || '',
      description: '',
      type: typeVal,
      units: row.units ?? null,
      is_enabled: row.is_enabled === true,
      config,
      priority: row.priority ?? 500,
      required: row.required !== false,
      is_custom: true,
      variable_name: row.variable_name || row.name,
      field_type: typeVal,
      qualification_prompt: row.qualification_prompt ?? null,
    };
  });
}

async function listWithCustom(companyId) {
  const presets = await listAllPresets(companyId);
  let custom = [];
  try {
    custom = await listCustomFields(companyId);
  } catch (_) {
    // Migration 052 not applied yet; return presets only
  }
  const combined = [...presets, ...custom].sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
  return combined;
}

async function createCustom(companyId, { label, field_type = 'text', qualification_prompt = null }) {
  const variable_name = sanitizeVariableName(label) || 'custom_field';
  const countResult = await pool.query(
    'SELECT COUNT(*)::int AS n FROM chatbot_quote_fields WHERE company_id = $1',
    [companyId]
  );
  const priority = (countResult.rows[0]?.n ?? 0) + 1;
  const qualPrompt = qualification_prompt || null;
  const result = await pool.query(
    `INSERT INTO chatbot_quote_fields (company_id, name, type, units, priority, required, is_enabled, config, is_custom, variable_name, field_type, label, qualification_prompt)
     VALUES ($1, $2, $3, NULL, $4, true, true, '{}'::jsonb, true, $5, $6, $7, $8)
     RETURNING id, name, type, units, priority, required, is_enabled, config, variable_name, field_type, label, qualification_prompt`,
    [companyId, variable_name, field_type, priority, variable_name, field_type, (label || '').trim(), qualPrompt]
  );
  const row = result.rows[0];
  return {
    id: row.id,
    name: row.variable_name || row.name,
    label: row.label || row.name,
    type: row.field_type || row.type,
    is_custom: true,
    variable_name: row.variable_name,
    field_type: row.field_type || row.type,
    priority: row.priority,
    is_enabled: row.is_enabled === true,
    required: row.required !== false,
    config: row.config || {},
    units: row.units,
    description: '',
    qualification_prompt: row.qualification_prompt ?? null,
  };
}

async function updateCustomField(companyId, id, { qualification_prompt }) {
  const sets = [];
  const vals = [id, companyId];
  let idx = 3;
  if (qualification_prompt !== undefined) {
    sets.push(`qualification_prompt = $${idx++}`);
    vals.push(qualification_prompt || null);
  }
  if (sets.length === 0) return null;
  const result = await pool.query(
    `UPDATE chatbot_quote_fields SET ${sets.join(', ')} WHERE id = $1 AND company_id = $2 AND is_custom = true RETURNING id, qualification_prompt`,
    vals
  );
  return result.rows[0] ?? null;
}

async function deleteCustomById(companyId, id) {
  const result = await pool.query(
    'DELETE FROM chatbot_quote_fields WHERE id = $1 AND company_id = $2 AND is_custom = true RETURNING id',
    [id, companyId]
  );
  return result.rowCount > 0;
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
  listCopilotFields,
  listCustomFields,
  listWithCustom,
  updatePresets,
  listQuotePresets,
  upsertQuotePreset,
  bulkUpsertQuotePresets,
  getEnabledFields,
  getFields,
  createCustom,
  updateCustomField,
  deleteCustomById,
  PRESET_NAMES,
  getPresetType,
  getDefaultConfig,
};
