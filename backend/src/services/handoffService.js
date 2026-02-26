/**
 * Handoff Service — Human-Break / Takeover System
 *
 * Evaluates incoming messages against configurable handoff rules.
 * When triggered: pauses bot for that conversation, creates notification,
 * optionally sends a bridging message, and logs the event.
 */

const { pool } = require('../../db');
const { conversationRepository } = require('../../db/repositories');
const { createNotification } = require('./notificationService');
const { claudeWithRetry } = require('../utils/claudeWithRetry');

/**
 * Fetch active handoff rules for a company, ordered by priority.
 */
async function getRules(companyId) {
  const result = await pool.query(
    'SELECT * FROM handoff_rules WHERE company_id = $1 AND is_active = true ORDER BY priority ASC',
    [companyId]
  );
  return result.rows;
}

/**
 * Evaluate a message against all active handoff rules.
 * Returns the first matching rule, or null.
 */
async function evaluateRules(companyId, messageText) {
  if (!messageText || typeof messageText !== 'string') return null;
  const rules = await getRules(companyId);
  if (!rules.length) return null;

  const lower = messageText.toLowerCase();

  for (const rule of rules) {
    const triggerValue = (rule.trigger_value || '').toLowerCase().trim();
    if (!triggerValue) continue;

    switch (rule.rule_type) {
      case 'keyword': {
        // trigger_value is comma-separated keywords
        const keywords = triggerValue.split(',').map(k => k.trim()).filter(Boolean);
        const matched = keywords.some(kw => {
          // Word boundary match to avoid partial matches
          const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
          return re.test(messageText);
        });
        if (matched) return rule;
        break;
      }
      case 'topic': {
        // trigger_value is comma-separated topic keywords (broader match)
        const topics = triggerValue.split(',').map(t => t.trim()).filter(Boolean);
        if (topics.some(t => lower.includes(t))) return rule;
        break;
      }
      case 'sentiment': {
        // trigger_value is a sentiment keyword like "frustrated", "angry"
        // Basic detection: look for strong negative indicators
        const negativePatterns = [
          /\b(angry|furious|pissed|outraged)\b/i,
          /\b(terrible|horrible|awful|worst)\b/i,
          /\b(scam|fraud|rip.?off|waste)\b/i,
          /\b(never again|unacceptable|disgusting)\b/i,
          /!{3,}/, // Multiple exclamation marks
        ];
        const frustratedPatterns = [
          /\b(frustrated|annoying|disappointed|unhappy)\b/i,
          /\b(not working|broken|useless|ridiculous)\b/i,
        ];
        if (triggerValue.includes('angry') && negativePatterns.some(p => p.test(messageText))) return rule;
        if (triggerValue.includes('frustrated') && [...negativePatterns, ...frustratedPatterns].some(p => p.test(messageText))) return rule;
        break;
      }
      case 'explicit_request': {
        // Lead explicitly asks to speak to a human
        const humanRequestPatterns = [
          /\b(speak|talk|connect).*(human|person|real|someone|agent|manager|owner)\b/i,
          /\b(real person|actual person|not a bot|human agent)\b/i,
          /\b(let me talk|can i talk|i want to speak|get me.*human)\b/i,
          /\b(transfer me|connect me|put me through)\b/i,
        ];
        if (humanRequestPatterns.some(p => p.test(messageText))) return rule;
        break;
      }
      case 'message_count': {
        // This is handled separately in evaluateWithContext() since it needs conversation data
        break;
      }
      default:
        break;
    }
  }

  return null;
}

/**
 * Full evaluation including context-dependent rules (message count, hot lead).
 */
async function evaluateWithContext(companyId, leadId, messageText, context = {}) {
  // First check text-based rules
  const textRule = await evaluateRules(companyId, messageText);
  if (textRule) return textRule;

  // Then check context-dependent rules
  const rules = await getRules(companyId);
  const { messageCount, interestLevel } = context;

  for (const rule of rules) {
    const triggerValue = (rule.trigger_value || '').trim();

    if (rule.rule_type === 'message_count' && messageCount) {
      const threshold = parseInt(triggerValue, 10);
      if (threshold > 0 && messageCount >= threshold) return rule;
    }

    if (rule.rule_type === 'hot_lead' && interestLevel) {
      const threshold = parseInt(triggerValue, 10) || 8;
      if (interestLevel >= threshold) return rule;
    }
  }

  return null;
}

/**
 * Generate a short conversation summary for the business owner.
 * Returns 3-4 bullet points so the owner has instant context.
 */
async function generateConversationSummary(messages) {
  if (!messages || messages.length === 0) return null;
  try {
    const recent = messages.slice(-20);
    const transcript = recent.map(m => `${m.role}: ${m.content}`).join('\n');
    const { content } = await claudeWithRetry({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: `Summarize this conversation in 3-4 short bullet points for the business owner who needs to take over. Focus on: what the lead wants, any info collected, and the current situation.\n\n${transcript}` }],
    });
    const text = content?.[0]?.text || content?.text || null;
    return typeof text === 'string' ? text.trim() : null;
  } catch (err) {
    console.warn('[handoff] summary generation failed:', err.message);
    return null;
  }
}

/**
 * Execute a handoff: pause bot, log event, create notification with summary.
 * Returns { paused: true, bridgingMessage } or { paused: false }.
 */
async function executeHandoff(companyId, leadId, conversationId, rule, leadName) {
  // Pause the bot for this conversation
  await conversationRepository.pauseBot(leadId, rule.trigger_reason || rule.rule_type, 'rule');

  // Log the handoff event
  await pool.query(
    `INSERT INTO handoff_log (conversation_id, company_id, lead_id, rule_id, trigger_reason, paused_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [conversationId, companyId, leadId, rule.id, `${rule.rule_type}: ${rule.trigger_value}`]
  );

  // Generate conversation summary for the owner (non-blocking)
  const conv = await conversationRepository.getByLeadId(leadId);
  const summary = await generateConversationSummary(conv?.messages);

  // Create notification for the business owner
  const displayName = leadName || 'A lead';
  const ruleLabel = rule.rule_type === 'keyword' ? `mentioned "${rule.trigger_value}"`
    : rule.rule_type === 'explicit_request' ? 'asked to speak with a human'
    : rule.rule_type === 'sentiment' ? 'seems frustrated'
    : rule.rule_type === 'message_count' ? `sent ${rule.trigger_value}+ messages`
    : rule.rule_type === 'hot_lead' ? 'is a hot lead'
    : `triggered "${rule.rule_type}" rule`;

  const notificationBody = summary
    ? `${displayName} ${ruleLabel}. Bot paused.\n\n${summary}`
    : `${displayName} ${ruleLabel}. Bot paused — reply in inbox.`;

  await createNotification(
    companyId,
    'handoff_required',
    'Human attention needed',
    notificationBody,
    leadId,
    { rule_id: rule.id, rule_type: rule.rule_type, trigger_value: rule.trigger_value, summary }
  ).catch(err => console.warn('[handoff] notification error:', err.message));

  return {
    paused: true,
    bridgingMessage: rule.bridging_message || null,
  };
}

/**
 * Resume bot for a conversation and log it.
 */
async function resumeHandoff(leadId, resumedBy = 'manual') {
  await conversationRepository.resumeBot(leadId);

  // Update the most recent handoff log entry
  await pool.query(
    `UPDATE handoff_log
     SET resumed_at = NOW(), resumed_by = $1,
         owner_response_time_seconds = EXTRACT(EPOCH FROM (NOW() - paused_at))::int
     WHERE lead_id = $2 AND resumed_at IS NULL
     ORDER BY paused_at DESC LIMIT 1`,
    [resumedBy, leadId]
  ).catch(err => console.warn('[handoff] resume log update:', err.message));
}

/**
 * Get handoff status for a conversation.
 */
async function getHandoffStatus(leadId) {
  const conv = await conversationRepository.getByLeadId(leadId);
  if (!conv) return { paused: false };
  return {
    paused: conv.bot_paused,
    paused_at: conv.paused_at,
    paused_reason: conv.paused_reason,
    paused_by: conv.paused_by,
  };
}

/**
 * Find conversations that have been paused longer than the auto-resume timeout.
 */
async function findStaleHandoffs(companyId, autoResumeMinutes) {
  const result = await pool.query(
    `SELECT c.lead_id, c.paused_at, l.name as lead_name
     FROM conversations c
     JOIN leads l ON l.id = c.lead_id
     WHERE l.company_id = $1
       AND c.bot_paused = true
       AND c.paused_at < NOW() - ($2 || ' minutes')::interval`,
    [companyId, autoResumeMinutes]
  );
  return result.rows;
}

/**
 * Auto-resume cron: checks all companies for paused conversations past timeout.
 * Called periodically from the server index.
 */
async function runAutoResumeCron() {
  try {
    const companies = await pool.query(
      `SELECT cb.company_id, cb.auto_resume_minutes
       FROM chatbot_behavior cb
       WHERE cb.auto_resume_minutes > 0`
    );
    let resumed = 0;
    for (const row of companies.rows) {
      const stale = await findStaleHandoffs(row.company_id, row.auto_resume_minutes);
      for (const conv of stale) {
        console.log(`[handoff/auto-resume] Resuming bot for lead ${conv.lead_id} (paused ${row.auto_resume_minutes}+ min)`);
        await resumeHandoff(conv.lead_id, 'auto_resume');
        await createNotification(
          row.company_id,
          'handoff_auto_resumed',
          'Bot auto-resumed',
          `Bot resumed for ${conv.lead_name || 'a lead'} after ${row.auto_resume_minutes} min timeout.`,
          conv.lead_id
        ).catch(() => {});
        resumed++;
      }
    }
    if (resumed > 0) console.log(`[handoff/auto-resume] Resumed ${resumed} conversation(s)`);
  } catch (err) {
    console.error('[handoff/auto-resume] Error:', err.message);
  }
}

module.exports = {
  getRules,
  evaluateRules,
  evaluateWithContext,
  executeHandoff,
  resumeHandoff,
  getHandoffStatus,
  findStaleHandoffs,
  runAutoResumeCron,
};
