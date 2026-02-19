/**
 * Pure function: compute required_infos and collected_infos from quote fields and collected data.
 * @param {Array} quoteFields - [{ name, type, units, priority, required }] ordered by priority
 * @param {Array} collectedFields - [{ name, type, units, value, priority }] from DB
 * @returns {{ required_infos: Array, collected_infos: Array }}
 */
function computeFieldsState(quoteFields, collectedFields) {
  const quote = quoteFields ?? [];
  const collected = collectedFields ?? [];
  const collectedMap = Object.fromEntries(
    collected
      .filter((c) => c?.name != null && c?.value != null && String(c.value).trim() !== '')
      .map((c) => [String(c.name).trim(), c])
  );

  const requiredFields = quote
    .filter((f) => f?.required !== false)
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

  const required_infos = requiredFields
    .filter((f) => {
      const v = collectedMap[f.name]?.value;
      return v == null || String(v).trim() === '';
    })
    .map((f) => ({
      name: f.name ?? '',
      type: f.type ?? 'text',
      units: f.units ?? null,
      priority: f.priority ?? 100,
    }));

  const collected_infos = collected
    .filter((c) => c?.name != null && c?.value != null && String(c.value).trim() !== '')
    .map((c) => ({
      name: c.name,
      type: c.type ?? 'text',
      units: c.units ?? null,
      value: c.value,
      priority: c.priority ?? 100,
    }));

  return { required_infos, collected_infos };
}

module.exports = { computeFieldsState };
