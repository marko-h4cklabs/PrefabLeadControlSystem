const Anthropic = require('@anthropic-ai/sdk');
const { buildSystemPrompt, getLengthLimit, truncateToLimit } = require('./systemPrompt');

const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

async function callLLM(systemPrompt, userMessage, behavior) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });
  const textBlock = response.content?.find((b) => b.type === 'text');
  let text = textBlock?.text ?? '';
  const limit = getLengthLimit(behavior?.response_length);
  text = truncateToLimit(text, limit);
  return text;
}

module.exports = { callLLM };
