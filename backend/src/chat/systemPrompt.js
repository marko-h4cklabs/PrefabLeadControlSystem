/**
 * Build system prompt string that enforces chatbot behavior and quote collection.
 * @param {Object} behavior - { tone, response_length, emojis_enabled, persona_style, forbidden_topics }
 * @param {Object} companyInfo - { business_description, additional_notes }
 * @param {Array} quoteFields - Quote field definitions
 * @param {Object} collectedFields - Already collected { [fieldName]: value }
 */
function buildSystemPrompt(behavior, companyInfo, quoteFields, collectedFields) {
  const beh = behavior ?? {};
  const info = companyInfo ?? {};
  const fields = quoteFields ?? [];
  const collected = collectedFields ?? {};
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

  parts.push('## Response rules (MUST follow)');

  if (beh.persona_style === 'busy') {
    parts.push('- Persona: BUSY. No greetings, no apologies, no "Got it"/"Noted"/"Thanks", no filler, no long explanations. Max brevity. One question at a time when collecting fields.');
  } else {
    parts.push('- Persona: Explanational. You may explain but still respect response_length.');
  }

  parts.push(`- Tone: ${beh.tone ?? 'professional'}`);
  parts.push(`- Emojis: ${beh.emojis_enabled ? 'allowed' : 'FORBIDDEN - do not use any emojis'}`);

  const length = beh.response_length ?? 'medium';
  if (length === 'short') {
    parts.push('- Length: SHORT. 1-2 short sentences max, OR bullet list with max 3 bullets. Never multi-paragraph.');
  } else if (length === 'medium') {
    parts.push('- Length: MEDIUM. Max 5 sentences.');
  } else {
    parts.push('- Length: LONG. Max 12 sentences.');
  }

  if (beh.forbidden_topics && beh.forbidden_topics.length > 0) {
    parts.push(`- Forbidden topics (refuse briefly, redirect): ${beh.forbidden_topics.join(', ')}`);
  }

  parts.push('');
  parts.push('- Always prioritize collecting required quote fields if any are missing before giving long answers.');
  parts.push('- If the user provides info for a quote field, acknowledge briefly and move on.');

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
