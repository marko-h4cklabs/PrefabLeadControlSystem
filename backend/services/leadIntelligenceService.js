/**
 * Lead intelligence: intent scoring, tags, budget/urgency detection, conversation summary.
 * Runs after every inbound message (async, non-blocking).
 */

const logger = require('../src/lib/logger');
const Anthropic = require('@anthropic-ai/sdk');
const { claudeWithRetry } = require('../src/utils/claudeWithRetry');
// OPENAI_API_KEY=your_openai_key (optional fallback)
const { pool } = require('../db');

const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

const INTENT_SYSTEM_PROMPT = `You are a lead intelligence system. Analyze this conversation and return ONLY valid JSON, nothing else.

Detect the following and return as JSON:
{
  "intent_score": <integer 0-100>,
  "intent_tags": <array of strings from: ["pricing_inquiry", "ready_to_buy", "budget_mentioned", "objection", "not_interested", "scheduling_interest", "high_urgency", "low_urgency", "gathering_info", "competitor_mention"]>,
  "budget_detected": <string with the budget amount if mentioned, or null>,
  "urgency_level": <"high" | "medium" | "low" | "unknown">,
  "is_hot_lead": <boolean — true if score >= 70 OR "ready_to_buy" or "budget_mentioned" tags present>,
  "reasoning": <one sentence explaining the score>
}

Scoring guide:
- 0-30: Just browsing, no buying signals
- 31-60: Engaged, asking questions, showing interest
- 61-80: Strong intent, mentioned budget or timeframe
- 81-100: Ready to buy, asking about next steps or pricing explicitly`;

const SUMMARY_SYSTEM_PROMPT = `Summarize this sales conversation in 3-5 bullet points. Focus on:
- What the lead wants
- Budget or investment level mentioned
- Their main objection or hesitation if any
- Urgency or timeline
- Current stage in the conversation

Return ONLY the bullet points, no headers, no preamble. Each bullet max 15 words.`;

const VALID_TAGS = new Set([
  'pricing_inquiry', 'ready_to_buy', 'budget_mentioned', 'objection', 'not_interested',
  'scheduling_interest', 'high_urgency', 'low_urgency', 'gathering_info', 'competitor_mention',
]);

function buildContextFromMessages(messages, limit = 10) {
  const arr = Array.isArray(messages) ? messages.slice(-limit) : [];
  return arr.map((m) => `${m.role}: ${m.content || ''}`).join('\n');
}

function parseIntentJson(raw) {
  const trimmed = String(raw).trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  const jsonStr = jsonMatch ? jsonMatch[0] : trimmed;
  const parsed = JSON.parse(jsonStr);
  const intent_score = Math.min(100, Math.max(0, parseInt(parsed.intent_score, 10) || 0));
  let intent_tags = Array.isArray(parsed.intent_tags)
    ? parsed.intent_tags.filter((t) => typeof t === 'string' && VALID_TAGS.has(t))
    : [];
  if (intent_tags.length > 20) intent_tags = intent_tags.slice(0, 20);
  const budget_detected =
    parsed.budget_detected != null && String(parsed.budget_detected).trim() !== ''
      ? String(parsed.budget_detected).trim().slice(0, 255)
      : null;
  const urgency_level = ['high', 'medium', 'low', 'unknown'].includes(parsed.urgency_level)
    ? parsed.urgency_level
    : 'unknown';
  const is_hot_lead = Boolean(
    parsed.is_hot_lead === true ||
      intent_score >= 70 ||
      intent_tags.includes('ready_to_buy') ||
      intent_tags.includes('budget_mentioned')
  );
  return {
    intent_score,
    intent_tags,
    budget_detected,
    urgency_level,
    is_hot_lead,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 500) : null,
  };
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

/**
 * Run intent scoring and update lead. Returns { justBecameHotLead }.
 */
async function runIntentScoring(leadId, companyId, messages) {
  const context = buildContextFromMessages(messages, 10);
  if (!context.trim()) return { justBecameHotLead: false };

  const userPrompt = `Conversation:\n${context}\n\nReturn ONLY the JSON object.`;
  let raw;
  try {
    raw = await callClaude(INTENT_SYSTEM_PROMPT, userPrompt, 512);
  } catch (err) {
    logger.error('[leadIntelligence] intent scoring Claude error:', err.message);
    return { justBecameHotLead: false };
  }

  let parsed;
  try {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    parsed = parseIntentJson(cleaned);
  } catch (err) {
    logger.error('[leadIntelligence] intent JSON parse error:', err.message);
    return { justBecameHotLead: false };
  }

  const prev = await pool.query(
    'SELECT is_hot_lead, budget_detected FROM leads WHERE id = $1 AND company_id = $2',
    [leadId, companyId]
  );
  const wasHot = prev.rows[0]?.is_hot_lead === true;
  const justBecameHotLead = parsed.is_hot_lead && !wasHot;
  const hadBudget = !!prev.rows[0]?.budget_detected;
  const nowHasBudget = !!parsed.budget_detected;

  await pool.query(
    `UPDATE leads SET
       intent_score = $1,
       intent_tags = $2,
       budget_detected = $3,
       urgency_level = $4,
       is_hot_lead = $5,
       hot_lead_triggered_at = CASE WHEN $5 = true AND (hot_lead_triggered_at IS NULL) THEN NOW() ELSE hot_lead_triggered_at END
     WHERE id = $6 AND company_id = $7`,
    [
      parsed.intent_score,
      parsed.intent_tags,
      parsed.budget_detected,
      parsed.urgency_level,
      parsed.is_hot_lead,
      leadId,
      companyId,
    ]
  );

  if (justBecameHotLead) {
    await pool.query(
      `INSERT INTO hot_lead_alerts (lead_id, company_id, trigger_reason, intent_score)
       VALUES ($1, $2, $3, $4)`,
      [leadId, companyId, parsed.reasoning || 'Score or tags indicated hot lead', parsed.intent_score]
    );
    if (typeof require !== 'undefined') {
      try {
        const { createNotification } = require('../src/services/notificationService');
        const leadRow = await pool.query('SELECT name FROM leads WHERE id = $1 AND company_id = $2', [leadId, companyId]);
        const leadName = leadRow.rows[0]?.name || 'Lead';
        await createNotification(
          companyId,
          'hot_lead',
          '🔥 Hot Lead Alert',
          `${leadName} has a score of ${parsed.intent_score}/100`,
          leadId
        );
      } catch (e) {
        logger.warn('[leadIntelligence] createNotification hot_lead:', e.message);
      }
    }
  }

  // Notify when budget is first detected
  if (!hadBudget && nowHasBudget) {
    try {
      const { createNotification } = require('../src/services/notificationService');
      const leadRow2 = await pool.query('SELECT name FROM leads WHERE id = $1 AND company_id = $2', [leadId, companyId]);
      const leadName2 = leadRow2.rows[0]?.name || 'Lead';
      await createNotification(
        companyId,
        'budget_detected',
        'Budget detected',
        `${leadName2}: ${parsed.budget_detected}`,
        leadId
      );
    } catch (e) {
      logger.warn('[leadIntelligence] createNotification budget_detected:', e.message);
    }
  }

  return { justBecameHotLead };
}

/**
 * Generate and save conversation summary for the lead.
 */
async function generateConversationSummary(leadId, messages) {
  const context = buildContextFromMessages(messages, 30);
  if (!context.trim()) return;

  try {
    const raw = await callClaude(SUMMARY_SYSTEM_PROMPT, `Conversation:\n${context}`, 512);
    const summary = (raw && String(raw).trim()) ? String(raw).trim().slice(0, 4000) : null;
    if (summary) {
      await pool.query(
        `UPDATE leads SET conversation_summary = $2, summary_updated_at = NOW() WHERE id = $1`,
        [leadId, summary]
      );
    }
  } catch (err) {
    logger.error('[leadIntelligence] summary Claude error:', err.message);
  }
}

/**
 * Main entry: run after every inbound message. Runs intent scoring, then summary every 3rd user message or when lead just became hot.
 */
async function analyzeInboundMessage(leadId, conversationId, companyId, messages) {
  const { justBecameHotLead } = await runIntentScoring(leadId, companyId, messages);
  const userMessageCount = (messages || []).filter((m) => m.role === 'user').length;
  const runSummary = userMessageCount % 3 === 0 || justBecameHotLead;
  if (runSummary) {
    await generateConversationSummary(leadId, messages);
  }
}

module.exports = { analyzeInboundMessage, runIntentScoring, generateConversationSummary };
