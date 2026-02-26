/**
 * Pure function: compute required_infos and collected_infos from quote fields and collected data.
 * Only includes presets where is_enabled=true.
 * @param {Array} quoteFields - [{ name, type, units, priority, required, is_enabled, config }] ordered by priority
 * @param {Array} collectedFields - [{ name, type, units, value, priority }] from DB
 * @returns {{ required_infos: Array, collected_infos: Array }}
 */
function computeFieldsState(quoteFields, collectedFields) {
  const quote = (quoteFields ?? []).filter((f) => f?.is_enabled !== false);
  const collected = collectedFields ?? [];
  const hasValue = (v) => v != null && (Array.isArray(v) ? v.length > 0 : String(v).trim() !== '');

  const collectedMap = Object.fromEntries(
    collected
      .filter((c) => c?.name != null && hasValue(c.value))
      .map((c) => [String(c.name).trim(), c])
  );

  const requiredFields = quote
    .filter((f) => f?.required !== false)
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

  const required_infos = requiredFields
    .filter((f) => {
      const v = collectedMap[f.name]?.value;
      return !hasValue(v);
    })
    .map((f) => ({
      name: f.name ?? '',
      label: f.label || (f.name ?? '').replace(/_/g, ' '),
      type: f.type ?? 'text',
      units: f.units ?? null,
      priority: f.priority ?? 100,
    }));

  const collected_infos = collected
    .filter((c) => c?.name != null && hasValue(c.value))
    .map((c) => ({
      name: c.name,
      type: c.type ?? 'text',
      units: c.units ?? null,
      value: c.value,
      priority: c.priority ?? 100,
      ...(c.links != null && { links: c.links }),
    }));

  return { required_infos, collected_infos };
}

/**
 * Build highlights object for frontend panel.
 */
function buildHighlights(quoteFields, collectedInfos, requiredInfos, behavior) {
  const configured = (quoteFields ?? []).map((f) => ({
    name: f.name ?? '',
    type: f.type ?? 'text',
    units: f.units ?? null,
    priority: f.priority ?? 100,
    required: f.required !== false,
  }));
  const missing_required = (requiredInfos ?? []).map((f) => ({
    name: f.name ?? '',
    type: f.type ?? 'text',
    units: f.units ?? null,
    priority: f.priority ?? 100,
    required: true,
  }));
  const collected = (collectedInfos ?? []).map((c) => ({
    name: c.name,
    type: c.type ?? 'text',
    units: c.units ?? null,
    value: c.value,
    ...(c.links != null && { links: c.links }),
  }));
  const step_index = collected.length;
  const is_complete = (requiredInfos ?? []).length === 0;
  return {
    settings: {
      tone: behavior?.tone ?? 'professional',
      persona_style: behavior?.persona_style ?? 'busy',
      response_length: behavior?.response_length ?? 'medium',
      emojis_enabled: behavior?.emojis_enabled ?? false,
    },
    fields: {
      configured,
      missing_required,
      collected,
    },
    state: {
      step_index,
      is_complete,
    },
  };
}

module.exports = { computeFieldsState, buildHighlights };
