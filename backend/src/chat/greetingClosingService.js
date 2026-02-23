/**
 * Generate contextual greeting based on opener_style and agent_name.
 * Never use "Hello! I'm {name}, your AI assistant".
 */

const CASUAL_OPENERS = [
  "What's good, thanks for reaching out 👋",
  "Hey! Thanks for the message",
  "Hey there, what can I do for you?",
  "Hey, glad you reached out — what's up?",
];

const PROFESSIONAL_OPENERS = [
  "Thanks for reaching out, happy to help.",
  "Hi there — thanks for your message.",
  "Hello, thanks for getting in touch.",
];

const DIRECT_OPENERS = [
  "Hey — what are you looking for?",
  "What can I help you with?",
  "Hey, what do you need?",
];

function pickRandom(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return arr[0];
  return arr[Math.floor(Math.random() * arr.length)];
}

async function generateGreeting(userMessage, behavior) {
  const beh = behavior ?? {};
  const openerStyle = beh.opener_style ?? 'casual';
  const emojis = beh.emojis_enabled ?? false;

  let openers;
  if (openerStyle === 'professional') {
    openers = PROFESSIONAL_OPENERS;
  } else if (openerStyle === 'direct') {
    openers = DIRECT_OPENERS;
  } else {
    openers = CASUAL_OPENERS;
  }

  let greeting = pickRandom(openers);
  if (!emojis && greeting.includes('👋')) {
    greeting = greeting.replace(/\s*👋\s*/g, ' ').trim();
  }
  return greeting;
}

async function generateClosing(userMessage, collectedFields, behavior) {
  const beh = behavior ?? {};
  const tone = beh.tone ?? 'professional';
  const persona = beh.persona_style ?? 'busy';
  const emojis = beh.emojis_enabled ?? false;
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const collectedStr = Object.keys(collectedFields ?? {}).length ? `Collected: ${JSON.stringify(collectedFields)}` : 'No fields collected';
    const response = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-sart-4-6',
      max_tokens: 32,
      system: `You output a closing. Rules:
- ONLY 2-3 words. No punctuation.
- Tone: ${tone}. Persona: ${persona}. Busy = minimal.
- No emojis unless explicitly allowed.
- Examples: "We'll follow up" "Got it thanks" "Done."`,
      messages: [{ role: 'user', content: userMessage ? `${userMessage}\n${collectedStr}` : collectedStr }],
    });
    const text = response.content?.find((b) => b.type === 'text')?.text ?? '';
    const words = (text.replace(/[.!?]+$/, '').trim().split(/\s+/).filter(Boolean)).slice(0, 3);
    return words.join(' ') || "We'll follow up";
  } catch (err) {
    console.info('[greetingClosingService] closing fallback:', err.message);
    return "We'll follow up";
  }
}

module.exports = { generateGreeting, generateClosing };
