/**
 * Normalize dimensions value to string format for storage and API response.
 * Input: object { length, width, height, unit? } or JSON string of same.
 * Config: { enabledParts: ['length','width','height'], unit: 'm' }
 * Output: "2x2x2 m" or "2x3 m" or "2 m" (unit omitted if missing)
 */
function dimensionsToDisplayString(value, config = {}) {
  if (value == null) return null;
  let obj = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+(\.\d+)?(\s*[x×]\s*\d+(\.\d+)?)*(\s*[a-z]+)?$/i.test(trimmed)) {
      return trimmed;
    }
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  if (typeof obj !== 'object' || Array.isArray(obj)) return String(value);
  const enabledParts = config?.enabledParts ?? ['length', 'width', 'height'];
  const defaultUnit = config?.unit ?? obj?.unit ?? 'm';
  const parts = [];
  for (const p of enabledParts) {
    const v = obj[p];
    if (v != null && (typeof v === 'number' ? !Number.isNaN(v) : true)) {
      parts.push(String(v));
    }
  }
  if (parts.length === 0) return null;
  const dimStr = parts.join('x');
  const unit = obj?.unit ?? defaultUnit;
  return unit ? `${dimStr} ${unit}` : dimStr;
}

module.exports = { dimensionsToDisplayString };
