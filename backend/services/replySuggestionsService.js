/**
 * Copilot mode: generate 3 reply suggestions for human to choose and send.
 */

const logger = require('../src/lib/logger');
const Anthropic = require('@anthropic-ai/sdk');
const { claudeWithRetry } = require('../src/utils/claudeWithRetry');
const { pool } = require('../db');
const {
  conversationRepository,
  chatbotBehaviorRepository,
  chatbotCompanyInfoRepository,
  chatbotQuoteFieldsRepository,
} = require('../db/repositories');
const { buildSystemPrompt } = require('../src/services/systemPromptBuilder');
const { decrypt } = require('../src/lib/encryption');
const { companyRepository } = require('../db/repositories');
const { sendInstagramMessage } = require('../src/services/manychatService');
const { publish: publishEvent } = require('../src/lib/eventBus');

const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

function buildSuggestionPrompt(behavior) {
  const goal = behavior?.conversation_goal || 'booking a call';
  const lengthHint = behavior?.response_length === 'short' ? '1-2' : '2-4';
  const emojisOk = behavior?.emojis_enabled ? '' : 'No emojis. ';

  // No-trailing-period rule (standalone from human error style)
  const noTrailingPeriodRule = behavior?.no_trailing_period
    ? '\n- Do NOT end any message with a period (.). Stop after the last word — no trailing punctuation.'
    : '';

  // Human error style — explicitly enforce the user's settings on the text values inside JSON
  let humanErrorRules = '';
  if (!behavior?.human_error_enabled) {
    humanErrorRules = '\n- Write in clean, standard English. No typos, no casual short forms, no stylistic imperfections. Polished text only.';
  } else {
    const types = Array.isArray(behavior.human_error_types) ? behavior.human_error_types : [];
    const errorDescriptions = {
      typos: 'include occasional small typos (e.g. "teh", "somethng") — max 1 per message',
      no_periods: 'do NOT end messages with a period — stop after the last word',
      lowercase_starts: 'sometimes start sentences with lowercase like a real text',
      short_forms: 'use casual short forms: "ur", "u", "rn", "gonna", "wanna", "ngl", "tbh"',
    };
    // Exclude double_messages — [SPLIT] would corrupt the JSON output
    const activeRules = types.filter((t) => t !== 'double_messages').map((t) => errorDescriptions[t]).filter(Boolean);
    if (activeRules.length > 0) {
      humanErrorRules = '\n- MANDATORY human writing style — apply these to the text values in JSON:\n' + activeRules.map((r) => `  • ${r}`).join('\n');
    }
  }

  return `

Based on this conversation, generate EXACTLY 3 different reply options.
Each must have a distinct STRATEGY, not just a different tone.

REPLY 1 — DIRECT CLOSER:
Short, confident, moves directly toward ${goal}.
No fluff. Clear next step.

REPLY 2 — VALUE BUILDER:
Leads with a relevant insight, result, or social proof.
Makes them feel they'd be missing out by not continuing.

REPLY 3 — CURIOUS QUALIFIER:
Asks one smart question to understand their situation better.
Makes them feel heard and understood.

Return ONLY valid JSON in this exact format, nothing else:
{
  "suggestions": [
    { "index": 0, "label": "Direct Closer", "text": "..." },
    { "index": 1, "label": "Value Builder", "text": "..." },
    { "index": 2, "label": "Curious Qualifier", "text": "..." }
  ]
}

Apply these rules to ALL replies:
- ${emojisOk}Max ${lengthHint} sentences each
- Sound human, not robotic
- No formal greetings or sign-offs${noTrailingPeriodRule}${humanErrorRules}
`;
}

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
    .filter((s) => s && Number.isInteger(s.index) && typeof s.label === 'string' && (typeof s.text === 'string' || typeof s.content === 'string'))
    .map((s) => ({ index: s.index, label: String(s.label).slice(0, 50), text: String(s.text || s.content || '').slice(0, 4000) }))
    .slice(0, 3);
}

/**
 * Generate 3 suggestions, save to reply_suggestions, return suggestions array.
 */
async function generateSuggestions(leadId, conversationId, companyId, messages, behavior) {
  if (!conversationId || !leadId || !companyId) {
    throw new Error('leadId, conversationId, and companyId are required');
  }

  // Kill switch check
  try {
    const botCheck = await pool.query('SELECT bot_enabled FROM companies WHERE id = $1', [companyId]);
    if (botCheck.rows[0]?.bot_enabled === false) {
      logger.info({ companyId }, '[replySuggestions] Bot disabled (kill switch), skipping');
      return { suggestion_id: null, suggestions: [] };
    }
  } catch (colErr) {
    // bot_enabled column may not exist yet — proceed (bot is on by default)
    if (!(colErr.message && colErr.message.includes('bot_enabled'))) throw colErr;
  }

  // Load copilot-mode-scoped config
  const mode = 'copilot';
  const [companyInfo, companyRecord, quoteFields, convRow, personaRow] = await Promise.all([
    chatbotCompanyInfoRepository.get(companyId, mode),
    companyRepository.findById(companyId),
    chatbotQuoteFieldsRepository.list(companyId, mode),
    pool.query('SELECT parsed_fields, quote_snapshot FROM conversations WHERE id = $1 AND lead_id = $2', [conversationId, leadId]),
    pool.query(`SELECT id, name, system_prompt, agent_name, tone, opener_style FROM chatbot_personas WHERE company_id = $1 AND is_active = true AND COALESCE(operating_mode, 'autopilot') = $2 LIMIT 1`, [companyId, mode]).then((r) => r.rows[0] ?? null),
  ]);

  const conv = convRow.rows[0];
  const quoteSnapshot = conv?.quote_snapshot;
  const validTypes = ['text', 'number', 'select_multi', 'composite_dimensions', 'boolean', 'pictures'];
  // Always use LIVE fields from settings — copilot fields are dynamic (add/remove/toggle
  // in Fields tab takes effect immediately across all conversations, no stale snapshots)
  const orderedQuoteFields = (quoteFields || [])
    .filter((f) => f && f.is_enabled !== false && validTypes.includes(f.type))
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

  logger.info({ companyId, quoteFieldsCount: (quoteFields || []).length, snapshotCount: (quoteSnapshot || []).length, orderedCount: orderedQuoteFields.length, fieldNames: orderedQuoteFields.map((f) => f.label || f.name) }, '[replySuggestions] Field awareness: loaded fields');

  // Load copilot-specific behavior — repository.get() handles AI persona snapshot merge via LEFT JOIN
  const effectiveBehavior = behavior ?? await chatbotBehaviorRepository.get(companyId, mode);
  if (effectiveBehavior?.copilot_persona_source === 'ai_generated' && effectiveBehavior?._active_ai_persona) {
    logger.info({ companyId, persona: effectiveBehavior._active_ai_persona.name }, '[replySuggestions] Using AI-generated persona');
  }

  // Compute missing fields for field-aware suggestions
  const parsedFields = conv?.parsed_fields ?? {};
  const collectedKeysLower = new Set(
    Object.keys(parsedFields)
      .filter((k) => !k.startsWith('__') && parsedFields[k] != null && parsedFields[k] !== '')
      .map((k) => k.toLowerCase())
  );
  const missingFields = orderedQuoteFields
    .filter((f) => {
      const name = (f.name || '').toLowerCase();
      const label = (f.label || '').toLowerCase();
      return (f.label || f.name) && !collectedKeysLower.has(name) && !collectedKeysLower.has(label);
    })
    .map((f) => {
      const req = f.qualification_requirement ? ` (QUALIFICATION: ${f.qualification_requirement})` : '';
      return (f.label || f.name) + req;
    });

  // Build already-collected context so AI doesn't re-ask answered questions
  const collectedEntries = Object.entries(parsedFields)
    .filter(([k, v]) => !k.startsWith('__') && v != null && v !== '')
    .map(([k, v]) => `- ${k}: ${v}`);
  const collectedContext = collectedEntries.length > 0
    ? `\n\nALREADY COLLECTED (do NOT ask about these again):\n${collectedEntries.join('\n')}`
    : '';

  // Calendly URL: try behavior first, then companies table as fallback
  const calendlyUrl = effectiveBehavior?.calendly_url
    || companyRecord?.calendly_scheduling_url
    || companyRecord?.calendly_url
    || null;

  const hasQualRules = orderedQuoteFields.some((f) => f.qualification_requirement);
  const qualRulesSection = hasQualRules
    ? `\n\nQUALIFICATION RULES:\nWhen the lead provides a value for a field with a QUALIFICATION requirement, evaluate it immediately.\nIf the lead does NOT meet a requirement, acknowledge it politely and explain the limitation.\nDo NOT continue collecting remaining fields if a critical qualification fails.`
    : '';

  const isRapportMode = (effectiveBehavior?.conversation_approach || 'field_focused') === 'rapport_building';

  let fieldAwarenessPrompt = '';
  if (missingFields.length > 0) {
    const fieldList = missingFields.map((f, i) => `${i + 1}. ${f}`).join('\n');
    if (isRapportMode) {
      fieldAwarenessPrompt = `${collectedContext}\n\nFIELDS STILL NEEDED (collect naturally — no rush):\n${fieldList}\n\nYou are in rapport-building mode. Do NOT ask for these fields aggressively or back-to-back. Work toward ONE field naturally when the timing feels right in the conversation. If the conversation is still warming up, it's okay to not ask for a field yet — prioritize connection and vibe first. Never make it feel like a form.\nDo NOT ask about fields already collected above. Do NOT ask for name, phone, email, or anything not in this list.${qualRulesSection}`;
    } else {
      fieldAwarenessPrompt = `${collectedContext}\n\nCRITICAL — REQUIRED FIELDS NOT YET COLLECTED:\n${fieldList}\n\nYou MUST incorporate questions about these fields into your suggestions. Each reply option should naturally work toward collecting at least one of these missing fields. Do NOT ignore them — they are required before the conversation can advance to ${effectiveBehavior?.conversation_goal || 'booking a call'}.\nDo NOT ask about fields already collected above. Do NOT ask for name, phone, email, or anything not in this list. Stay focused and conversational.${qualRulesSection}`;
    }
  } else if (orderedQuoteFields.length > 0) {
    const bookingMsg = calendlyUrl
      ? `All required fields have been collected! NOW suggest booking a call. You MUST include this EXACT Calendly link verbatim in at least one suggestion: ${calendlyUrl}\nNEVER use placeholders like [BOOKING LINK] or [LINK]. Copy-paste the URL exactly as shown above.\nDo NOT ask what day or time works. Just share the Calendly link and let them book directly.`
      : `All required fields have been collected! Focus on advancing toward the goal: ${effectiveBehavior?.conversation_goal || 'booking a call'}.`;
    fieldAwarenessPrompt = `${collectedContext}\n\n${bookingMsg}`;
  }

  if (missingFields.length > 0) {
    logger.info({ companyId, missingFields, collectedKeys: [...collectedKeysLower] }, '[replySuggestions] Missing fields detected');
  }

  const company = {
    name: companyRecord?.name || 'our company',
    business_description: companyInfo?.business_description ?? '',
    additional_notes: companyInfo?.additional_notes ?? '',
  };
  const baseSystemPrompt = await buildSystemPrompt(company, effectiveBehavior, orderedQuoteFields, personaRow);
  const systemPrompt = baseSystemPrompt + buildSuggestionPrompt(effectiveBehavior) + fieldAwarenessPrompt;
  const userPrompt = buildUserPrompt(messages);

  const raw = await callClaude(systemPrompt, userPrompt, 1024);
  let suggestions;
  try {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    suggestions = parseSuggestionsJson(cleaned);
  } catch (e) {
    logger.error('[replySuggestions] Failed to parse LLM JSON response, skipping');
    return [];
  }

  const result = await pool.query(
    `INSERT INTO reply_suggestions (conversation_id, lead_id, company_id, suggestions, context_snapshot)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING id, suggestions`,
    [conversationId, leadId, companyId, JSON.stringify(suggestions), null]
  );
  const row = result.rows[0];
  const parsedSuggestions = row ? (row.suggestions && typeof row.suggestions === 'object' ? row.suggestions : JSON.parse(row.suggestions || '[]')) : suggestions;

  // Emit SSE event so setter sees suggestions in real-time
  publishEvent(companyId, {
    type: 'suggestion_ready',
    leadId,
    conversationId,
    suggestionId: row?.id || null,
  }).catch(() => {});

  return { suggestion_id: row?.id || null, suggestions: parsedSuggestions };
}

/**
 * Send a suggestion by index and mark it used.
 */
async function sendSuggestion(suggestionId, suggestionIndex, companyId) {
  const row = await pool.query(
    `SELECT id, lead_id, company_id, conversation_id, suggestions, used_at FROM reply_suggestions
     WHERE id = $1 AND company_id = $2`,
    [suggestionId, companyId]
  );
  const rec = row.rows[0];
  if (!rec) return null;
  // Already sent — return success without re-sending (idempotent)
  if (rec.used_at) return { success: true, already_sent: true };

  const suggestions = Array.isArray(rec.suggestions) ? rec.suggestions : (typeof rec.suggestions === 'string' ? JSON.parse(rec.suggestions || '[]') : []);
  const chosen = suggestions.find((s) => s.index === suggestionIndex);
  if (!chosen || typeof chosen.text !== 'string') return null;

  const leadRow = await pool.query(
    'SELECT l.external_id, c.manychat_api_key FROM leads l JOIN companies c ON c.id = l.company_id WHERE l.id = $1 AND l.company_id = $2',
    [rec.lead_id, companyId]
  );
  const lead = leadRow.rows[0];
  if (!lead?.external_id || !lead?.manychat_api_key) return null;

  await sendInstagramMessage(lead.external_id, chosen.text, decrypt(lead.manychat_api_key)).catch((err) => {
    throw err;
  });

  await conversationRepository.appendMessage(rec.lead_id, 'assistant', chosen.text);

  await pool.query(
    `UPDATE reply_suggestions SET used_suggestion_index = $2, used_at = NOW() WHERE id = $1`,
    [suggestionId, suggestionIndex]
  );

  // Emit SSE event with full message data so frontend can display instantly
  publishEvent(companyId, {
    type: 'new_message',
    leadId: rec.lead_id,
    conversationId: rec.conversation_id,
    preview: chosen.text.slice(0, 100),
    role: 'assistant',
    content: chosen.text,
    messageTimestamp: new Date().toISOString(),
  }).catch(() => {});

  return { success: true, message_sent: chosen.text };
}

module.exports = { generateSuggestions, sendSuggestion };
