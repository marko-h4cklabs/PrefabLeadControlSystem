/**
 * Enforce chatbot behavior settings on assistant message.
 * Run on every assistant draft before returning to client.
 */
function stripEmojis(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();
}

const BOT_TELL_STARTS = [
  /^Great![\s,]*/i,
  /^Absolutely![\s,]*/i,
  /^Of course![\s,]*/i,
  /^Certainly![\s,]*/i,
  /^Sure thing![\s,]*/i,
  /^Happy to help[\s,]*/i,
  /^I'd be happy to[\s,]*/i,
  /^I'm here to[\s,]*/i,
  /^As an AI[\s,]*/i,
  /^As an assistant[\s,]*/i,
];

const BOT_TELL_ANYWHERE = [
  /\s*As an AI[^.]*\.?/gi,
  /\s*I am an AI[^.]*\.?/gi,
  /\s*I'm an AI[^.]*\.?/gi,
  /\s*artificial intelligence[^.]*\.?/gi,
  /\s*language model[^.]*\.?/gi,
  /\s*I was trained[^.]*\.?/gi,
];

function stripBotTells(text) {
  if (!text || typeof text !== 'string') return text;
  let s = text;
  for (const re of BOT_TELL_STARTS) {
    s = s.replace(re, '');
  }
  for (const re of BOT_TELL_ANYWHERE) {
    s = s.replace(re, '');
  }
  s = s.replace(/!+/g, '!');
  return s.replace(/\s+/g, ' ').trim();
}

function limitToShort(text) {
  if (!text || typeof text !== 'string') return text;
  const raw = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const sentences = raw.filter((s) => s.replace(/[.!?,\s\-]+/g, '').length > 0);
  if (sentences.length <= 2) return text.trim();
  const bulletMatch = text.match(/^[•\-\*]\s+.+$/gm);
  if (bulletMatch && bulletMatch.length <= 3) return text.trim();
  const limited = sentences.slice(0, 2).join(' ');
  const lastPeriod = limited.lastIndexOf('.');
  return lastPeriod > 0 ? limited.slice(0, lastPeriod + 1) : limited;
}

function enforceForbiddenTopics(text, forbiddenTopics, replacement) {
  if (!text || !Array.isArray(forbiddenTopics) || forbiddenTopics.length === 0) return text;
  const lower = text.toLowerCase();
  const hit = forbiddenTopics.some((t) => {
    const term = (t || '').toLowerCase().trim();
    return term && lower.includes(term);
  });
  if (!hit) return text;
  return replacement || "I can't help with that — is there something else I can assist with?";
}

/**
 * Get the human-readable display name for a field.
 * Uses the label if available, otherwise converts variable_name to "Variable Name".
 */
function getFieldDisplayName(field) {
  if (!field) return '';
  if (field.label && field.label.trim()) return field.label.trim();
  return (field.name || '').replace(/_/g, ' ');
}

/**
 * Check if the reply already asks about the target field naturally.
 * Returns true if the reply contains a question mentioning the field.
 */
function alreadyAsksAboutField(text, field) {
  if (!text || !field) return false;
  const lower = text.toLowerCase();
  if (!lower.includes('?')) return false;

  const displayName = getFieldDisplayName(field).toLowerCase();
  const rawName = (field.name || '').toLowerCase().replace(/_/g, ' ');

  return lower.includes(displayName) || lower.includes(rawName);
}

/**
 * If the AI reply doesn't end with a question and there's a missing field,
 * nudge the conversation toward that field naturally — NOT by appending
 * "What is your phone_number?" but with a human-sounding follow-up.
 */
function ensureConversationAdvances(text, topMissingField) {
  if (!text || !topMissingField) return text;
  const trimmed = text.trim();
  if (!trimmed) return trimmed;

  // If the reply already ends with a question, leave it alone
  if (trimmed.endsWith('?')) return trimmed;

  // If the reply already mentions the field, leave it alone
  if (alreadyAsksAboutField(trimmed, topMissingField)) return trimmed;

  // Don't append anything — the system prompt already instructs the AI to ask
  // for missing fields naturally. Forcefully appending questions sounds robotic.
  // The AI will ask in the next turn if it didn't this time.
  return trimmed;
}

/**
 * Strip em-dashes and double dashes — a dead giveaway of chatbot-generated text.
 * Replace with comma or space depending on context.
 */
function stripDashes(text) {
  if (!text || typeof text !== 'string') return text;
  // Replace " — " or " -- " (with spaces) with ", "
  let result = text.replace(/\s*[—–]\s*/g, ', ');
  result = result.replace(/\s*--\s*/g, ', ');
  // Clean up double commas or comma at start
  result = result.replace(/^,\s*/, '').replace(/,\s*,/g, ',');
  return result;
}

function enforceStyle(text, behavior, options = {}) {
  let result = text || '';
  result = stripBotTells(result);
  result = stripDashes(result);
  const beh = behavior ?? {};
  const { topMissingField } = options;

  if (beh.emojis_enabled === false) {
    result = stripEmojis(result);
  }

  if (beh.response_length === 'short') {
    result = limitToShort(result);
  }

  if (beh.forbidden_topics && beh.forbidden_topics.length > 0) {
    const repl = topMissingField
      ? `I can't help with that, but I'd love to help with what you're looking for. What's your ${getFieldDisplayName(topMissingField)}?`
      : options.forbiddenReplacement || "I can't help with that, is there something else I can assist with?";
    result = enforceForbiddenTopics(result, beh.forbidden_topics, repl);
  }

  // Only nudge if the AI completely failed to advance the conversation
  if (topMissingField) {
    result = ensureConversationAdvances(result, topMissingField);
  }

  return result.trim() || text;
}

module.exports = { enforceStyle, stripEmojis, stripBotTells, limitToShort, getFieldDisplayName };
