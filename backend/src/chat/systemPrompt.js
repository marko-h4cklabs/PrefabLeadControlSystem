/**
 * Build system prompt string that enforces chatbot behavior and quote collection.
 * @param {Object} behavior - { tone, response_length, emojis_enabled, persona_style, forbidden_topics }
 * @param {Object} companyInfo - { business_description, additional_notes }
 * @param {Array} quoteFields - Quote field definitions
 * @param {Object} collectedFields - Already collected { [fieldName]: value }
 * @param {Array} requiredInfos - Missing required fields [{ name, type, units, priority }]
 */
function buildSystemPrompt(behavior, companyInfo, quoteFields, collectedFields, requiredInfos = []) {
  const beh = behavior ?? {};
  const info = companyInfo ?? {};
  const fields = quoteFields ?? [];
  const collected = collectedFields ?? {};
  const missing = requiredInfos ?? [];
  const parts = [];

  parts.push('You are a helpful sales assistant for a prefab/modular construction company.');
  parts.push('');

  if (info.business_description) {
    parts.push('## Company context');
    parts.push(`Business: ${info.business_description}`);
    if (info.additional_notes) {
      parts.push(`Notes: ${info.additional_notes}`);
    }
    parts.push('');
  }

  const collectedEntries = Object.entries(collected).filter(([, v]) => v != null && String(v).trim() !== '');
  if (collectedEntries.length > 0) {
    parts.push('## Collected quote info so far');
    parts.push(collectedEntries.map(([k, v]) => `${k}: ${v}`).join(', '));
    parts.push('');
  }

  const configuredNames = fields.map((f) => f.name).filter(Boolean);
  parts.push('## ENABLED FIELDS (scope lock)');
  parts.push(`Ask ONLY for these enabled fields: ${configuredNames.join(', ') || 'none'}`);
  parts.push('Do NOT ask for anything outside this list.');
  parts.push('If a field has an options list, treat those as allowed values; if user gives a value outside the list, ask them to choose from the list.');
  parts.push('For dimensions, collect only the enabled parts (length/width/height) and unit.');
  parts.push('');

  if (missing.length > 0) {
    parts.push('## Required infos (missing - MUST ask for)');
    parts.push(missing.map((m) => `${m.name} (${m.type}${m.units ? `, ${m.units}` : ''})`).join(', '));
    const topField = missing[0];
    const askOne = beh.response_length === 'short' ? 'Ask ONLY for the top priority missing field.' : 'Ask for the top priority missing field; optionally 1 more if medium/long.';
    parts.push(`CRITICAL: ${askOne} End with ONE direct question for ${topField?.name ?? 'that field'}.`);
    parts.push('');
  }

  parts.push('## Response rules (MUST follow)');

  if (beh.persona_style === 'busy') {
    parts.push('- Persona: BUSY. No filler ("Gotcha", "Sure", "Happy to help"), no apologies. Max brevity. A short "Hi" at conversation start is allowed.');
  } else {
    parts.push('- Persona: Explanational. You may explain but still respect response_length.');
  }

  parts.push(`- Tone: ${beh.tone ?? 'professional'}`);
  parts.push(`- Emojis: ${beh.emojis_enabled ? 'allowed' : 'FORBIDDEN - do not use any emojis'}`);

  const length = beh.response_length ?? 'medium';
  if (length === 'short') {
    parts.push('- Length: SHORT. Max 1 sentence + 1 question, OR max 3 bullets total. Prefer 1 direct question.');
  } else if (length === 'medium') {
    parts.push('- Length: MEDIUM. Up to 2-3 sentences.');
  } else {
    parts.push('- Length: LONG. Can be longer but still only ask configured fields.');
  }

  if (beh.forbidden_topics && beh.forbidden_topics.length > 0) {
    parts.push(`- Forbidden topics (refuse briefly, redirect): ${beh.forbidden_topics.join(', ')}`);
  }

  parts.push('');
  parts.push('- If required_infos is not empty, the assistant MUST ask for the highest priority missing field.');
  parts.push('- If the user asks about something outside configured fields (e.g. doors, windows), answer in 1 line max then ask for the next missing required field.');
  parts.push('- When all required fields are collected: give a 1-2 line busy summary using ONLY collected fields, then a closing line. Do not ask new questions.');

  return parts.join('\n').trim();
}

function getLengthLimit(responseLength) {
  switch (responseLength) {
    case 'short':
      return 250;
    case 'medium':
      return 800;
    case 'long':
      return 2000;
    default:
      return 800;
  }
}

function truncateToLimit(text, limit) {
  if (!text || typeof text !== 'string') return '';
  const t = text.trim();
  if (t.length <= limit) return t;
  let cut = t.slice(0, limit);
  const lastPeriod = cut.lastIndexOf('.');
  if (lastPeriod > limit * 0.6) {
    cut = cut.slice(0, lastPeriod + 1);
  } else {
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace > limit * 0.5) cut = cut.slice(0, lastSpace);
  }
  return cut.trim();
}

function buildFieldQuestion(fieldName, behavior, units = null) {
  const beh = behavior ?? {};
  const tone = beh.tone ?? 'professional';
  const persona = beh.persona_style ?? 'busy';
  const suffix = units ? ` (${units})` : '';

  const questions = {
    busy_professional: `${fieldName}${suffix}?`,
    busy_friendly: `${fieldName}${suffix}?`,
    explanational_professional: `Could you provide the ${fieldName}${suffix}?`,
    explanational_friendly: `Could you tell me the ${fieldName}${suffix}?`,
  };
  const key = `${persona}_${tone}`;
  return questions[key] ?? questions.busy_professional;
}

module.exports = { buildSystemPrompt, getLengthLimit, truncateToLimit, buildFieldQuestion };
