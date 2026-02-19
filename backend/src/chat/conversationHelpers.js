/**
 * Helpers for greeting/goodbye rules in busy+short style.
 */

function shouldGreet(assistantMessageCount) {
  return (assistantMessageCount ?? 0) === 0;
}

function shouldGoodbye(userText, missingRequiredFields) {
  if (!missingRequiredFields || missingRequiredFields.length === 0) return true;
  return false;
}

function hasGoodbyeAlready(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return lower.includes("we'll") && (lower.includes('back') || lower.includes('follow'));
}

const BUSY_GREETINGS = [
  'Hi. Quick details first:',
  'Hi — need a few details:',
];

const BUSY_GOODBYES = [
  "Got it. We'll get back to you.",
  "Done. We'll follow up shortly.",
];

function addGreeting(text, behavior) {
  if (!text || typeof text !== 'string') return text;
  const beh = behavior ?? {};
  if (beh.persona_style !== 'busy') return text;
  const greeting = BUSY_GREETINGS[Math.floor(Math.random() * BUSY_GREETINGS.length)];
  const trimmed = text.trim();
  if (trimmed.toLowerCase().startsWith('hi') || trimmed.toLowerCase().startsWith('hello')) {
    return text;
  }
  return `${greeting} ${trimmed}`;
}

function addGoodbye(text, behavior) {
  if (!text || typeof text !== 'string') return text;
  if (hasGoodbyeAlready(text)) return text;
  const beh = behavior ?? {};
  if (beh.persona_style !== 'busy') return text;
  const goodbye = BUSY_GOODBYES[Math.floor(Math.random() * BUSY_GOODBYES.length)];
  const trimmed = text.trim();
  return `${trimmed} ${goodbye}`;
}

module.exports = { shouldGreet, shouldGoodbye, addGreeting, addGoodbye, hasGoodbyeAlready };
