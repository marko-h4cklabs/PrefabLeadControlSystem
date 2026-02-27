/**
 * Generate contextual greeting based on opener_style and agent_name.
 * Never use "Hello! I'm {name}, your AI assistant".
 */

const CASUAL_OPENERS = [
  "Hey, thanks for reaching out!",
  "Hey! What can I do for you?",
  "Hey there, glad you messaged",
  "Hey, what's up?",
];

const PROFESSIONAL_OPENERS = [
  "Thanks for reaching out, happy to help.",
  "Hi there, thanks for your message.",
  "Hello, thanks for getting in touch.",
  "Hi, how can I help you today?",
];

const QUESTION_OPENERS = [
  "Hey! What caught your eye?",
  "Hey, what are you looking for?",
  "Hi! What can I help you with?",
  "Hey, what brings you here?",
];

const STATEMENT_OPENERS = [
  "Hey, glad you reached out — you're in the right place.",
  "Hey! You came to the right spot.",
  "Good timing — happy to chat.",
  "Hey, glad you messaged us!",
];

const FORMAL_OPENERS = [
  "Thank you for getting in touch.",
  "Hello, it's great to hear from you.",
  "Good day, thank you for your message.",
  "Hello, I appreciate you reaching out.",
];

const DIRECT_OPENERS = [
  "Hey — what are you looking for?",
  "What can I help you with?",
  "Hey, what do you need?",
  "What's on your mind?",
];

function pickRandom(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return arr?.[0] ?? '';
  return arr[Math.floor(Math.random() * arr.length)];
}

async function generateGreeting(userMessage, behavior) {
  const beh = behavior ?? {};
  const openerStyle = beh.opener_style ?? 'casual';
  const emojis = beh.emojis_enabled ?? false;

  const openerMap = {
    casual: CASUAL_OPENERS,
    professional: PROFESSIONAL_OPENERS,
    question: QUESTION_OPENERS,
    statement: STATEMENT_OPENERS,
    formal: FORMAL_OPENERS,
    direct: DIRECT_OPENERS,
  };

  const openers = openerMap[openerStyle] || CASUAL_OPENERS;
  let greeting = pickRandom(openers);

  if (!emojis) {
    greeting = greeting.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();
  }
  return greeting;
}

async function generateClosing(userMessage, collectedFields, behavior) {
  // Disabled: canned closing phrases ("We got you", "Stay tuned", etc.) sound robotic
  // and bypass the AI prompt, making them uncontrollable. The AI handles natural
  // conversation endings through the system prompt.
  return '';
}

module.exports = { generateGreeting, generateClosing };
