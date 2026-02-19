/**
 * Helpers for greeting/closing rules. Contextual, 2-3 words.
 */

function shouldGreet(assistantMessageCount) {
  return (assistantMessageCount ?? 0) === 0;
}

const CLOSING_PATTERNS = /\b(thanks|thank you|that'?s all|ok bye|bye|that'?s it|done|no more|nothing else|that'?s everything|goodbye|cheers|ok that'?s all)\b/i;

function shouldClose(userText, missingRequiredFields) {
  if (!missingRequiredFields || missingRequiredFields.length === 0) return true;
  if (!userText || typeof userText !== 'string') return false;
  return CLOSING_PATTERNS.test(userText.trim());
}

function shouldGoodbye(userText, missingRequiredFields) {
  return shouldClose(userText, missingRequiredFields);
}

function hasClosingAlready(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return (
    lower.includes("we'll") ||
    lower.includes('follow up') ||
    lower.includes('get back') ||
    lower.includes('thanks') ||
    lower.includes('bye')
  );
}

function prependGreeting(text, greetingWords) {
  if (!text || typeof text !== 'string') return text;
  const g = (greetingWords || '').trim();
  if (!g) return text;
  const trimmed = text.trim();
  if (trimmed.toLowerCase().startsWith('hi') || trimmed.toLowerCase().startsWith('hello')) {
    return text;
  }
  return `${g} ${trimmed}`;
}

function appendClosing(text, closingWords) {
  if (!text || typeof text !== 'string') return text;
  if (hasClosingAlready(text)) return text;
  const c = (closingWords || '').trim();
  if (!c) return text;
  const trimmed = text.trim();
  return `${trimmed} ${c}`;
}

module.exports = {
  shouldGreet,
  shouldClose,
  shouldGoodbye,
  prependGreeting,
  appendClosing,
  hasClosingAlready,
};
