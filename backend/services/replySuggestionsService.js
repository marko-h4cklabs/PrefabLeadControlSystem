/**
 * Copilot mode: generate 3 reply suggestions for human to choose and send.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { claudeWithRetry } = require('../src/utils/claudeWithRetry');
const { pool } = require('../db');
const {
  conversationRepository,
  chatbotBehaviorRepository,
  chatbotCompanyInfoRepository,
  chatbotQuoteFieldsRepository,
} = require('../db/repositories');
const { buildSystemPrompt } = require('../src/chat/systemPrompt');
const { sendInstagramMessage } = require('../src/services/manychatService');

const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

const COPILOT_APPEND = `

Instead of sending ONE reply, generate exactly 3 different reply options for the human setter to choose from.

Each option should have a different approach:
Option 1 — Direct and concise: Gets straight to the point
Option 2 — Empathetic and warm: Acknowledges their situation before moving forward
Option 3 — Strategic: Moves the conversation toward the goal most effectively

Return ONLY valid JSON in this exact format, nothing else:
{
  "suggestions": [
    { "index": 0, "label": "Direct", "text": "..." },
    { "index": 1, "label": "Empathetic", "text": "..." },
    { "index": 2, "label": "Strategic", "text": "..." }
  ]
}

Each suggestion must follow all tone, persona, and behavior rules from the system prompt.
Each suggestion must be a complete ready-to-send message.`;

async function callClaude(systemPrompt, userPrompt, maxTokens = 1024) {
  const { content } = await claudeWithRetry({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });
  return content ?? '';
}

function buildUserPrompt(messages) {
  const history = (messages ?? [])
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');
  return `Conversation so far:\n${history || '(no messages yet)'}\n\nGenerate the 3 reply options as JSON only.`;
}

function parseSuggestionsJson(raw) {
  const trimmed = String(raw).trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  const jsonStr = jsonMatch ? jsonMatch[0] : trimmed;
  const parsed = JSON.parse(jsonStr);
  const suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
  return suggestions
    .filter((s) => s && Number.isInteger(s.index) && typeof s.label === 'string' && typeof s.text === 'string')
    .map((s) => ({ index: s.index, label: String(s.label).slice(0, 50), text: String(s.text).slice(0, 4000) }))
    .slice(0, 3);
}

/**
 * Generate 3 suggestions, save to reply_suggestions, return suggestions array.
 */
async function generateSuggestions(leadId, conversationId, companyId, messages, behavior) {
  if (!conversationId || !leadId || !companyId) {
    throw new Error('leadId, conversationId, and companyId are required');
  }

  const [companyInfo, quoteFields, convRow] = await Promise.all([
    chatbotCompanyInfoRepository.get(companyId),
    chatbotQuoteFieldsRepository.list(companyId),
    pool.query('SELECT parsed_fields, quote_snapshot FROM conversations WHERE id = $1 AND lead_id = $2', [conversationId, leadId]),
  ]);

  const conv = convRow.rows[0];
  const parsed_fields = conv?.parsed_fields ?? {};
  const quoteSnapshot = conv?.quote_snapshot ?? [];
  const validTypes = ['text', 'number', 'select_multi', 'composite_dimensions', 'boolean', 'pictures'];
  const orderedQuoteFields = (Array.isArray(quoteSnapshot) ? quoteSnapshot : [])
    .filter((f) => f && validTypes.includes(f.type))
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  const collectedMap = typeof parsed_fields === 'object' ? parsed_fields : {};

  const baseSystemPrompt = buildSystemPrompt(behavior ?? {}, companyInfo ?? {}, orderedQuoteFields, collectedMap, [], null);
  const systemPrompt = baseSystemPrompt + COPILOT_APPEND;
  const userPrompt = buildUserPrompt(messages);

  const raw = await callClaude(systemPrompt, userPrompt, 1024);
  let suggestions;
  try {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    suggestions = parseSuggestionsJson(cleaned);
  } catch (e) {
    console.error('[replySuggestions] Failed to parse LLM JSON response, skipping');
    return [];
  }

  const result = await pool.query(
    `INSERT INTO reply_suggestions (conversation_id, lead_id, company_id, suggestions, context_snapshot)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING id, suggestions`,
    [conversationId, leadId, companyId, JSON.stringify(suggestions), null]
  );
  const row = result.rows[0];
  return row ? (row.suggestions && typeof row.suggestions === 'object' ? row.suggestions : JSON.parse(row.suggestions || '[]')) : suggestions;
}

/**
 * Send a suggestion by index and mark it used.
 */
async function sendSuggestion(suggestionId, suggestionIndex, companyId) {
  const row = await pool.query(
    `SELECT id, lead_id, company_id, conversation_id, suggestions FROM reply_suggestions
     WHERE id = $1 AND company_id = $2`,
    [suggestionId, companyId]
  );
  const rec = row.rows[0];
  if (!rec) return null;

  const suggestions = Array.isArray(rec.suggestions) ? rec.suggestions : (typeof rec.suggestions === 'string' ? JSON.parse(rec.suggestions || '[]') : []);
  const chosen = suggestions.find((s) => s.index === suggestionIndex);
  if (!chosen || typeof chosen.text !== 'string') return null;

  const leadRow = await pool.query(
    'SELECT l.external_id, c.manychat_api_key FROM leads l JOIN companies c ON c.id = l.company_id WHERE l.id = $1 AND l.company_id = $2',
    [rec.lead_id, companyId]
  );
  const lead = leadRow.rows[0];
  if (!lead?.external_id || !lead?.manychat_api_key) return null;

  await sendInstagramMessage(lead.external_id, chosen.text, lead.manychat_api_key).catch((err) => {
    throw err;
  });

  await conversationRepository.appendMessage(rec.lead_id, 'assistant', chosen.text);

  await pool.query(
    `UPDATE reply_suggestions SET used_suggestion_index = $2, used_at = NOW() WHERE id = $1`,
    [suggestionId, suggestionIndex]
  );

  return { success: true, message_sent: chosen.text };
}

module.exports = { generateSuggestions, sendSuggestion };
