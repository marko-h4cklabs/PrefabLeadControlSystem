/**
 * Extract quote field values from user message text.
 * @param {string} messageText - Raw user message
 * @param {Array<{name,type,units,priority,required}>} quoteFields - Quote field definitions
 * @returns {Object} - { [fieldName]: value }
 */
function extractQuoteFields(messageText, quoteFields) {
  if (!messageText || typeof messageText !== 'string' || !Array.isArray(quoteFields)) {
    return {};
  }
  const text = messageText.trim();
  if (!text) return {};
  const extracted = {};

  for (const field of quoteFields) {
    const name = (field.name || '').trim().toLowerCase();
    if (!name) continue;
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const type = (field.type || 'text').toLowerCase();

    if (type === 'number') {
      const patterns = [
        new RegExp(`${escapedName}\\s*[:=]?\\s*([\\d,.'\\s]+)`, 'i'),
        new RegExp(`${escapedName}\\s+([\\d,.'\\s]+)`, 'i'),
      ];
      for (const re of patterns) {
        const match = text.match(re);
        if (match) {
          const raw = (match[1] || '').replace(/[,\s]/g, '').replace(/'/g, '');
          const num = parseFloat(raw);
          if (!Number.isNaN(num)) {
            extracted[field.name] = num;
            break;
          }
        }
      }
      if (extracted[field.name] === undefined) {
        const currencyMatch = text.match(new RegExp(`${escapedName}.*?(\\d[\\d,.]*)\\s*(?:usd|eur|€|\\$|k|m)?`, 'i'));
        if (currencyMatch) {
          const raw = (currencyMatch[1] || '').replace(/[,\s]/g, '');
          const num = parseFloat(raw);
          if (!Number.isNaN(num)) extracted[field.name] = num;
        }
      }
    } else if (type === 'text') {
      const colonMatch = text.match(new RegExp(`${escapedName}\\s*[:=]\\s*([^\\n,.]+)`, 'i'));
      if (colonMatch) {
        extracted[field.name] = colonMatch[1].trim();
        continue;
      }
      if (name === 'location' || name === 'city' || name.includes('location')) {
        const inMatch = text.match(/\bin\s+([A-Za-z][A-Za-z\s\-']{1,80})\b/);
        if (inMatch) {
          extracted[field.name] = inMatch[1].trim();
        }
      }
    }
  }
  return extracted;
}

module.exports = { extractQuoteFields };
