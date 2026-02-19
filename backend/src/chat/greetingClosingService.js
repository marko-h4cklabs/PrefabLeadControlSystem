/**
 * Generate contextual 2-3 word greeting/closing via Claude.
 * Matches user energy and respects tone/persona.
 */
const Anthropic = require('@anthropic-ai/sdk');

const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

function trimToWords(text, maxWords = 3) {
  if (!text || typeof text !== 'string') return '';
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, maxWords).join(' ');
}

async function generateGreeting(userMessage, behavior) {
  const beh = behavior ?? {};
  const tone = beh.tone ?? 'professional';
  const persona = beh.persona_style ?? 'busy';
  const emojis = beh.emojis_enabled ?? false;
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model,
      max_tokens: 32,
      system: `You output a greeting. Rules:
- ONLY 2-3 words. No punctuation.
- Match user energy: if user says "hi" → simple; if formal → formal.
- Tone: ${tone}. Persona: ${persona}. Busy = minimal.
- No emojis unless explicitly allowed.`,
      messages: [{ role: 'user', content: userMessage || 'hi' }],
    });
    const text = response.content?.find((b) => b.type === 'text')?.text ?? '';
    return trimToWords(text.replace(/[.!?]+$/, ''), 3) || 'Hi';
  } catch (err) {
    console.info('[greetingClosingService] greeting fallback:', err.message);
    return 'Hi';
  }
}

async function generateClosing(userMessage, collectedFields, behavior) {
  const beh = behavior ?? {};
  const tone = beh.tone ?? 'professional';
  const persona = beh.persona_style ?? 'busy';
  const emojis = beh.emojis_enabled ?? false;
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const collectedStr = Object.keys(collectedFields ?? {}).length ? `Collected: ${JSON.stringify(collectedFields)}` : 'No fields collected';
    const response = await client.messages.create({
      model,
      max_tokens: 32,
      system: `You output a closing. Rules:
- ONLY 2-3 words. No punctuation.
- Tone: ${tone}. Persona: ${persona}. Busy = minimal.
- No emojis unless explicitly allowed.
- Examples: "We'll follow up" "Got it thanks" "Done."`,
      messages: [{ role: 'user', content: userMessage ? `${userMessage}\n${collectedStr}` : collectedStr }],
    });
    const text = response.content?.find((b) => b.type === 'text')?.text ?? '';
    return trimToWords(text.replace(/[.!?]+$/, ''), 3) || "We'll follow up";
  } catch (err) {
    console.info('[greetingClosingService] closing fallback:', err.message);
    return "We'll follow up";
  }
}

module.exports = { generateGreeting, generateClosing };
