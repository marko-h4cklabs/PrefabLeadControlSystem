const { claudeWithRetry } = require('../utils/claudeWithRetry');
const { buildSystemPrompt, getLengthLimit, truncateToLimit } = require('./systemPrompt');

const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

async function callLLM(systemPrompt, userMessage, behavior) {
  const { content } = await claudeWithRetry({
    model,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });
  let text = content ?? '';
  const limit = getLengthLimit(behavior?.response_length);
  text = truncateToLimit(text, limit);
  return text;
}

module.exports = { callLLM };
