/**
 * Claude with retry and OpenAI fallback.
 * Env: ANTHROPIC_API_KEY, OPENAI_API_KEY=your_openai_key (optional fallback when Claude is overloaded)
 */
const logger = require('../lib/logger');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Lazy-init OpenAI client — SDK throws if apiKey is undefined at construction time
let _openai = null;
function getOpenAI() {
  if (!_openai) {
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'sk-placeholder' });
  }
  return _openai;
}

async function claudeWithRetry(claudeParams, maxRetries = 3) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await anthropic.messages.create(claudeParams);
      if (attempt > 0) logger.info(`[claude] Succeeded on retry ${attempt + 1}`);
      const text = response.content?.[0]?.text ?? '';
      return { provider: 'claude', content: text };
    } catch (err) {
      lastError = err;
      const isRetryable =
        err.status === 529 ||
        err.status === 503 ||
        err.status === 502 ||
        err.error?.error?.type === 'overloaded_error';
      if (!isRetryable) {
        logger.error(`[claude] Non-retryable error: ${err.status}`);
        break;
      }
      const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
      logger.warn(
        `[claude] Overloaded, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  logger.warn('[claude] All retries exhausted. Falling back to OpenAI GPT-4o...');
  try {
    const openaiMessages = [];
    if (claudeParams.system) {
      openaiMessages.push({ role: 'system', content: claudeParams.system });
    }
    for (const msg of claudeParams.messages || []) {
      openaiMessages.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content:
          typeof msg.content === 'string'
            ? msg.content
            : (msg.content || []).map((c) => c.text || '').join(''),
      });
    }
    const response = await getOpenAI().chat.completions.create({
      model: 'gpt-4o',
      messages: openaiMessages,
      max_tokens: claudeParams.max_tokens || 1000,
      temperature: 0.7,
    });
    logger.info('[openai] Fallback succeeded via GPT-4o');
    const text = response.choices?.[0]?.message?.content ?? '';
    return { provider: 'openai', content: text };
  } catch (openaiErr) {
    logger.error('[openai] Fallback also failed:', openaiErr.message);
    // Alert: both AI providers are down
    const { sendAdminAlert } = require('../services/adminAlertService');
    sendAdminAlert(
      'ai:both_failed',
      'Both Claude and OpenAI failed',
      { claudeError: lastError?.message, openaiError: openaiErr.message }
    ).catch(() => {});
    throw new Error(
      `Both Claude and OpenAI failed. Claude: ${lastError?.message}. OpenAI: ${openaiErr.message}`
    );
  }
}

module.exports = { claudeWithRetry, anthropic, get openai() { return getOpenAI(); } };
