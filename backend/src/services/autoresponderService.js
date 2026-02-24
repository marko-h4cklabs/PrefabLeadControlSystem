/**
 * Autoresponder rules: evaluate triggers and execute actions (send_message, assign_setter, move_pipeline_stage, notify_team).
 */
const { pool } = require('../../db');
const { createNotification } = require('./notificationService');
const { sendInstagramMessage } = require('./manychatService');

async function getActiveRules(companyId) {
  const r = await pool.query(
    `SELECT id, company_id, name, trigger_type, trigger_value, action_type, action_value, is_active, priority, match_count
     FROM autoresponder_rules WHERE company_id = $1 AND is_active = true ORDER BY priority DESC, created_at ASC`,
    [companyId]
  );
  return r.rows || [];
}

async function updateRuleMatchCount(ruleId) {
  await pool.query(
    'UPDATE autoresponder_rules SET match_count = COALESCE(match_count, 0) + 1 WHERE id = $1',
    [ruleId]
  );
}

async function executeRuleAction(rule, lead, company, manychatApiKey) {
  const companyId = company.id;
  const leadId = lead.id;
  const externalId = lead.external_id;

  if (rule.action_type === 'send_message' && rule.action_value && manychatApiKey) {
    await sendInstagramMessage(externalId, rule.action_value, manychatApiKey);
  } else if (rule.action_type === 'assign_setter' && rule.action_value) {
    const setterId = rule.action_value.trim();
    const check = await pool.query(
      'SELECT id FROM team_members WHERE id = $1 AND company_id = $2 AND is_active = true',
      [setterId, companyId]
    );
    if (check.rows[0]) {
      await pool.query('UPDATE leads SET assigned_setter_id = $1 WHERE id = $2 AND company_id = $3', [
        setterId,
        leadId,
        companyId,
      ]);
    }
  } else if (rule.action_type === 'move_pipeline_stage' && rule.action_value) {
    await pool.query(
      'UPDATE leads SET pipeline_stage = $1, pipeline_moved_at = NOW() WHERE id = $2 AND company_id = $3',
      [rule.action_value.trim(), leadId, companyId]
    );
  } else if (rule.action_type === 'notify_team') {
    await createNotification(
      companyId,
      'autoresponder',
      rule.name || 'Rule triggered',
      rule.action_value || `Lead ${lead.name || lead.id} matched rule`,
      leadId
    );
  }
}

async function evaluateAutoresponderRules(lead, message, company, manychatApiKey, options = {}) {
  const rules = await getActiveRules(company.id);
  const messageText = (message && message.text) ? String(message.text).toLowerCase() : '';
  const userMessageCount = options.messageCount ?? lead.message_count ?? 0;

  for (const rule of rules.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))) {
    let matched = false;
    const triggerVal = (rule.trigger_value || '').toLowerCase().trim();

    if (rule.trigger_type === 'keyword_contains') {
      matched = triggerVal && messageText.includes(triggerVal);
    } else if (rule.trigger_type === 'keyword_exact') {
      matched = triggerVal && messageText === triggerVal;
    } else if (rule.trigger_type === 'first_message') {
      matched = userMessageCount === 1;
    } else if (rule.trigger_type === 'intent_score_above') {
      const threshold = parseInt(rule.trigger_value, 10);
      matched = !isNaN(threshold) && (lead.intent_score ?? 0) >= threshold;
    } else if (rule.trigger_type === 'budget_detected') {
      matched = !!(lead.budget_detected && String(lead.budget_detected).trim());
    } else if (rule.trigger_type === 'no_reply_hours') {
      const hours = parseInt(rule.trigger_value, 10);
      if (!isNaN(hours) && lead.last_engagement_at) {
        const diff = (Date.now() - new Date(lead.last_engagement_at).getTime()) / (1000 * 60 * 60);
        matched = diff >= hours;
      }
    }

    if (matched) {
      await executeRuleAction(rule, lead, company, manychatApiKey);
      await updateRuleMatchCount(rule.id);
    }
  }
}

module.exports = { getActiveRules, evaluateAutoresponderRules, updateRuleMatchCount, executeRuleAction };
