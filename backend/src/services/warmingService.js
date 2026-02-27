/**
 * Pre-call warming and no-show reduction.
 * Enrolls leads in sequences, processes steps via BullMQ, cancels on reply, calculates no-show risk.
 */

const logger = require('../lib/logger');
const IORedis = require('ioredis');
const { Queue } = require('bullmq');
const { pool } = require('../../db');
const { leadRepository, companyRepository, conversationRepository } = require('../../db/repositories');
const { sendInstagramMessage } = require('./manychatService');
const { createNotification } = require('./notificationService');
const { decrypt } = require('../lib/encryption');

const QUEUE_NAME = 'warming-queue';
let queue = null;
let connection = null;

function getConnection() {
  if (!connection) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error('REDIS_URL required for warming queue');
    connection = new IORedis(url, { maxRetriesPerRequest: null });
  }
  return connection;
}

function getQueue() {
  if (!queue) {
    queue = new Queue(QUEUE_NAME, {
      connection: getConnection(),
      defaultJobOptions: {
        removeOnComplete: { age: 86400, count: 5000 },
        removeOnFail: { age: 86400 * 3 },
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 10000,
        },
      },
    });
  }
  return queue;
}

function interpolate(template, vars) {
  let s = String(template ?? '');
  for (const [key, value] of Object.entries(vars)) {
    s = s.replace(new RegExp(`\\{${key}\\}`, 'gi'), String(value ?? '').trim());
  }
  return s;
}

/**
 * Enroll a lead in all active sequences for the company with the given trigger_event.
 * Creates warming_enrollments and schedules the first step via BullMQ.
 */
async function enrollLead(leadId, companyId, triggerEvent) {
  const sequences = await pool.query(
    `SELECT id FROM warming_sequences WHERE company_id = $1 AND trigger_event = $2 AND is_active = true`,
    [companyId, triggerEvent]
  );
  if (!sequences.rows.length) return { enrolled: 0 };

  const enrollments = [];
  for (const row of sequences.rows) {
    const seqId = row.id;
    const steps = await pool.query(
      `SELECT id, step_order, delay_minutes FROM warming_steps WHERE sequence_id = $1 ORDER BY step_order ASC`,
      [seqId]
    );
    if (!steps.rows.length) continue;

    const ins = await pool.query(
      `INSERT INTO warming_enrollments (lead_id, sequence_id, company_id, status)
       VALUES ($1, $2, $3, 'active')
       RETURNING id`,
      [leadId, seqId, companyId]
    );
    const enrollmentId = ins.rows[0].id;
    enrollments.push({ enrollmentId, sequenceId: seqId, steps: steps.rows });
  }

  for (const { enrollmentId, steps } of enrollments) {
    const first = steps[0];
    const delayMs = Math.max(0, (first.delay_minutes || 0) * 60 * 1000);
    try {
      await getQueue().add(
        'warming_step',
        { enrollmentId, stepId: first.id },
        { jobId: `warming-${enrollmentId}-${first.id}`, delay: delayMs }
      );
    } catch (err) {
      logger.error('[warming] schedule first step failed:', err.message);
    }
  }

  return { enrolled: enrollments.length };
}

/**
 * Enroll a lead in a single sequence by sequence ID (for manual enroll).
 */
async function enrollLeadInSequence(leadId, companyId, sequenceId) {
  const seq = await pool.query(
    `SELECT id FROM warming_sequences WHERE id = $1 AND company_id = $2 AND is_active = true`,
    [sequenceId, companyId]
  );
  if (!seq.rows[0]) return null;
  const steps = await pool.query(
    `SELECT id, step_order, delay_minutes FROM warming_steps WHERE sequence_id = $1 ORDER BY step_order ASC`,
    [sequenceId]
  );
  if (!steps.rows.length) return null;
  const ins = await pool.query(
    `INSERT INTO warming_enrollments (lead_id, sequence_id, company_id, status)
     VALUES ($1, $2, $3, 'active') RETURNING id`,
    [leadId, sequenceId, companyId]
  );
  const enrollmentId = ins.rows[0].id;
  const first = steps.rows[0];
  const delayMs = Math.max(0, (first.delay_minutes || 0) * 60 * 1000);
  await getQueue().add(
    'warming_step',
    { enrollmentId, stepId: first.id },
    { jobId: `warming-${enrollmentId}-${first.id}`, delay: delayMs }
  );
  return enrollmentId;
}

/**
 * Generate an AI-powered follow-up message using conversation context.
 */
async function generateAiFollowUp(lead, company, conversationMessages, previousFollowUps, aiPrompt) {
  try {
    const { claudeWithRetry } = require('../utils/claudeWithRetry');
    const leadName = lead.name || lead.external_id || 'there';
    const companyName = company.name || 'our company';

    // Build context from conversation
    const recentConvo = (conversationMessages || []).slice(-15).map(m => `${m.role}: ${m.content}`).join('\n');
    const prevFollowUps = (previousFollowUps || []).map(f => `Previous follow-up: ${f.message_sent}`).join('\n');

    const prompt = `You are ${companyName}'s follow-up assistant. Write a natural, human-sounding follow-up DM to ${leadName}.

CONTEXT:
${recentConvo ? `Recent conversation:\n${recentConvo}` : 'No prior conversation available.'}
${prevFollowUps ? `\n${prevFollowUps}` : ''}

${aiPrompt ? `INSTRUCTION: ${aiPrompt}` : ''}

RULES:
- Reference something specific from the conversation (not generic)
- Don't repeat angles from previous follow-ups
- Keep it to 1-2 sentences max
- Sound like a real person texting, not a bot
- Create curiosity or value, not pressure
- Never use "just checking in" or "following up"

Output ONLY the message text, nothing else.`;

    const { content } = await claudeWithRetry({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = content?.[0]?.text || content?.text || null;
    return typeof text === 'string' ? text.trim() : null;
  } catch (err) {
    logger.warn('[warming] AI follow-up generation failed:', err.message);
    return null;
  }
}

/**
 * Check branching conditions against lead/conversation state.
 * Returns true if the step should be executed, false if it should be skipped.
 */
function evaluateConditions(conditions, context) {
  if (!conditions) return true;

  // conditions: { skip_if_replied: true, skip_if_negative: true, only_if_no_reply: true }
  if (conditions.skip_if_replied && context.leadReplied) return false;
  if (conditions.only_if_no_reply && context.leadReplied) return false;
  if (conditions.skip_if_negative && context.lastSentiment === 'negative') return false;
  if (conditions.only_if_interested && context.lastSentiment !== 'positive') return false;

  return true;
}

/**
 * Process a single warming step (called by BullMQ worker).
 * Supports: static templates, AI-generated messages, branching conditions, escalation.
 */
async function processWarmingStep(enrollmentId, stepId) {
  const enrollment = await pool.query(
    `SELECT id, lead_id, sequence_id, company_id, status, current_step, follow_ups_sent, paused, escalated
     FROM warming_enrollments WHERE id = $1`,
    [enrollmentId]
  );
  const enr = enrollment.rows[0];
  if (!enr || enr.status !== 'active') return;
  if (enr.paused) return; // paused enrollment, skip

  const step = await pool.query(
    `SELECT id, step_order, delay_minutes, message_template, step_type, conditions, ai_context_prompt
     FROM warming_steps WHERE id = $1`,
    [stepId]
  );
  const st = step.rows[0];
  if (!st) return;

  const lead = await leadRepository.findById(enr.company_id, enr.lead_id);
  if (!lead) return;
  if (lead.status === 'qualified' || lead.status === 'disqualified') return;

  // Check if the lead replied since last follow-up (for branching conditions)
  const lastLogResult = await pool.query(
    `SELECT sent_at, lead_replied, reply_sentiment FROM warming_message_log
     WHERE enrollment_id = $1 ORDER BY sent_at DESC LIMIT 1`,
    [enrollmentId]
  );
  const lastLog = lastLogResult.rows[0];
  const leadReplied = lastLog?.lead_replied === true;
  const lastSentiment = lastLog?.reply_sentiment || null;

  // Evaluate branching conditions
  const conditions = st.conditions || null;
  if (!evaluateConditions(conditions, { leadReplied, lastSentiment })) {
    logger.info(`[warming] Step ${st.step_order} skipped due to conditions for enrollment ${enrollmentId}`);
    // Skip to next step
    await scheduleNextStep(enr, st, enrollmentId);
    return;
  }

  let company = {};
  try {
    const companyRow = await pool.query(
      `SELECT name, booking_url FROM companies WHERE id = $1`,
      [enr.company_id]
    );
    company = companyRow.rows[0] || {};
  } catch (_) {}
  const bookingUrl = company.booking_url != null ? String(company.booking_url) : '';

  let message;

  // AI-generated follow-up
  if (st.step_type === 'ai_generated') {
    const conversation = await conversationRepository.getByLeadId(enr.lead_id);
    const prevFollowUps = await pool.query(
      `SELECT message_sent FROM warming_message_log WHERE enrollment_id = $1 ORDER BY sent_at ASC`,
      [enrollmentId]
    );
    message = await generateAiFollowUp(lead, company, conversation?.messages, prevFollowUps.rows, st.ai_context_prompt);
    // Fallback to template if AI fails
    if (!message && st.message_template) {
      message = interpolate(st.message_template, {
        name: lead.name || lead.external_id || 'there',
        company_name: company.name || 'us',
        booking_link: bookingUrl,
      });
    }
    if (!message) message = `Hey ${lead.name || 'there'}, just wanted to check in — anything I can help with?`;
  } else {
    // Static template
    message = interpolate(st.message_template, {
      name: lead.name || lead.external_id || 'there',
      company_name: company.name || 'us',
      booking_link: bookingUrl,
    });
    message = message.replace(/\{booking_link\}/gi, bookingUrl).trim();
  }

  let manychatResponse = null;
  try {
    const mcRow = await pool.query(
      `SELECT manychat_api_key FROM companies WHERE id = $1`,
      [enr.company_id]
    );
    const apiKey = decrypt(mcRow.rows[0]?.manychat_api_key);
    if (apiKey && lead.external_id) {
      manychatResponse = await sendInstagramMessage(lead.external_id, message, apiKey);
    }
  } catch (err) {
    logger.error('[warming] send message failed:', err.message);
    manychatResponse = { error: err.message };
  }

  // Also log as assistant message in conversation so context is preserved
  await conversationRepository.appendMessage(enr.lead_id, 'assistant', message, { follow_up: true }).catch(() => {});

  await pool.query(
    `INSERT INTO warming_message_log (enrollment_id, lead_id, step_id, message_sent, manychat_response)
     VALUES ($1, $2, $3, $4, $5)`,
    [enrollmentId, enr.lead_id, stepId, message, manychatResponse ? JSON.stringify(manychatResponse) : null]
  );

  // Update follow-ups sent count
  await pool.query(
    `UPDATE warming_enrollments SET follow_ups_sent = COALESCE(follow_ups_sent, 0) + 1 WHERE id = $1`,
    [enrollmentId]
  );

  // Check if we should escalate (max follow-ups reached)
  const seqResult = await pool.query(
    `SELECT max_follow_ups, escalation_action, escalation_value FROM warming_sequences WHERE id = $1`,
    [enr.sequence_id]
  );
  const seq = seqResult.rows[0];
  const followUpsSent = (enr.follow_ups_sent || 0) + 1;
  if (seq?.max_follow_ups > 0 && followUpsSent >= seq.max_follow_ups && seq.escalation_action) {
    await handleEscalation(enr, lead, seq);
  }

  // Update daily analytics
  await updateDailyAnalytics(enr.company_id, enr.sequence_id);

  await scheduleNextStep(enr, st, enrollmentId);
}

/**
 * Handle escalation when max follow-ups reached.
 */
async function handleEscalation(enrollment, lead, sequence) {
  const action = sequence.escalation_action;
  const value = sequence.escalation_value;

  await pool.query(
    `UPDATE warming_enrollments SET escalated = true, escalation_action = $1 WHERE id = $2`,
    [action, enrollment.id]
  );

  switch (action) {
    case 'tag_cold':
      await pool.query('UPDATE leads SET pipeline_stage = $1 WHERE id = $2', ['cold', enrollment.lead_id]).catch(() => {});
      break;
    case 'notify_owner':
      await createNotification(
        enrollment.company_id,
        'followup_escalation',
        'Follow-up escalation',
        `${lead.name || 'A lead'} hasn't replied after ${sequence.max_follow_ups} follow-ups.`,
        enrollment.lead_id
      ).catch(() => {});
      break;
    case 'move_stage':
      if (value) {
        await pool.query('UPDATE leads SET pipeline_stage = $1 WHERE id = $2', [value, enrollment.lead_id]).catch(() => {});
      }
      break;
    case 'pause':
      await pool.query(
        `UPDATE warming_enrollments SET paused = true WHERE id = $1`,
        [enrollment.id]
      );
      break;
    default:
      break;
  }

  logger.info(`[warming] Escalation: ${action} for lead ${enrollment.lead_id} after ${sequence.max_follow_ups} follow-ups`);
}

/**
 * Analyze when a lead typically responds based on message history.
 * Returns the optimal hour (0-23) to send messages, or null if not enough data.
 */
async function getLeadActiveWindow(leadId) {
  try {
    // Look at the hours when this lead has replied/engaged
    const result = await pool.query(
      `SELECT EXTRACT(HOUR FROM replied_at) AS reply_hour, COUNT(*) AS cnt
       FROM warming_message_log
       WHERE lead_id = $1 AND lead_replied = true AND replied_at IS NOT NULL
       GROUP BY reply_hour ORDER BY cnt DESC LIMIT 3`,
      [leadId]
    );
    if (result.rows.length > 0) {
      // Weighted average of top reply hours
      const totalWeight = result.rows.reduce((s, r) => s + parseInt(r.cnt, 10), 0);
      const weighted = result.rows.reduce((s, r) => s + parseInt(r.reply_hour, 10) * parseInt(r.cnt, 10), 0);
      return Math.round(weighted / totalWeight);
    }

    // Fallback: check general conversation activity
    const convoResult = await pool.query(
      `SELECT EXTRACT(HOUR FROM m.created_at) AS msg_hour, COUNT(*) AS cnt
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.lead_id = $1 AND m.role = 'user'
       GROUP BY msg_hour ORDER BY cnt DESC LIMIT 3`,
      [leadId]
    );
    if (convoResult.rows.length > 0) {
      const totalWeight = convoResult.rows.reduce((s, r) => s + parseInt(r.cnt, 10), 0);
      const weighted = convoResult.rows.reduce((s, r) => s + parseInt(r.msg_hour, 10) * parseInt(r.cnt, 10), 0);
      return Math.round(weighted / totalWeight);
    }
    return null;
  } catch (err) {
    logger.warn('[warming] getLeadActiveWindow error:', err.message);
    return null;
  }
}

/**
 * Get company-wide best send hour as fallback for smart timing.
 */
async function getCompanyBestSendHour(companyId) {
  try {
    const result = await pool.query(
      `SELECT EXTRACT(HOUR FROM m.replied_at) AS reply_hour, COUNT(*) AS cnt
       FROM warming_message_log m
       JOIN warming_enrollments e ON e.id = m.enrollment_id
       WHERE e.company_id = $1 AND m.lead_replied = true AND m.replied_at IS NOT NULL
       GROUP BY reply_hour ORDER BY cnt DESC LIMIT 1`,
      [companyId]
    );
    return result.rows[0] ? parseInt(result.rows[0].reply_hour, 10) : null;
  } catch (_) {
    return null;
  }
}

/**
 * Calculate optimal send time for a message.
 * Combines base delay with smart timing (lead active window or company default).
 */
async function calculateSmartDelay(leadId, companyId, baseDelayMinutes) {
  const baseDelayMs = Math.max(0, (baseDelayMinutes || 0) * 60 * 1000);

  // Only apply smart timing for delays >= 1 hour (short delays are time-sensitive)
  if (baseDelayMinutes < 60) return { delayMs: baseDelayMs, smartTimed: false };

  const optimalHour = await getLeadActiveWindow(leadId) || await getCompanyBestSendHour(companyId);
  if (optimalHour === null) return { delayMs: baseDelayMs, smartTimed: false };

  // Calculate when the message would normally send
  const normalSendTime = new Date(Date.now() + baseDelayMs);
  const normalHour = normalSendTime.getUTCHours();

  // Adjust to nearest optimal hour (within the same day or next day)
  let adjustedTime = new Date(normalSendTime);
  adjustedTime.setUTCHours(optimalHour, 0, 0, 0);

  // If adjusted time is before the normal send time, push to next day
  if (adjustedTime <= normalSendTime) {
    adjustedTime.setUTCDate(adjustedTime.getUTCDate() + 1);
  }

  // Don't delay more than 12 hours beyond original time
  const maxDelay = baseDelayMs + 12 * 60 * 60 * 1000;
  const smartDelayMs = adjustedTime.getTime() - Date.now();
  const finalDelay = Math.min(smartDelayMs, maxDelay);

  return { delayMs: Math.max(baseDelayMs, finalDelay), smartTimed: true, optimalHour };
}

/**
 * Schedule the next warming step, or complete the enrollment.
 * Uses smart timing when available.
 */
async function scheduleNextStep(enrollment, currentStep, enrollmentId) {
  const nextSteps = await pool.query(
    `SELECT id, step_order, delay_minutes FROM warming_steps
     WHERE sequence_id = $1 AND step_order > $2 ORDER BY step_order ASC`,
    [enrollment.sequence_id, currentStep.step_order]
  );

  if (nextSteps.rows.length > 0) {
    const next = nextSteps.rows[0];
    await pool.query(
      `UPDATE warming_enrollments SET current_step = $2 WHERE id = $1`,
      [enrollmentId, next.step_order]
    );

    // Use smart timing
    const { delayMs, smartTimed } = await calculateSmartDelay(enrollment.lead_id, enrollment.company_id, next.delay_minutes);
    const nextSendAt = new Date(Date.now() + delayMs);

    // Track next_send_at for dashboard visibility
    await pool.query(
      `UPDATE warming_enrollments SET next_send_at = $2 WHERE id = $1`,
      [enrollmentId, nextSendAt]
    );

    await getQueue().add(
      'warming_step',
      { enrollmentId, stepId: next.id },
      { jobId: `warming-${enrollmentId}-${next.id}`, delay: delayMs }
    );

    if (smartTimed) {
      logger.info(`[warming] Smart timing: enrollment ${enrollmentId} next step at ${nextSendAt.toISOString()}`);
    }
  } else {
    await pool.query(
      `UPDATE warming_enrollments SET status = 'completed', completed_at = NOW(), next_send_at = NULL WHERE id = $1`,
      [enrollmentId]
    );
  }
}

/**
 * Cancel active enrollments for a lead for sequences with the given trigger_event.
 */
async function cancelEnrollment(leadId, triggerEvent) {
  const r = await pool.query(
    `UPDATE warming_enrollments e SET status = 'cancelled', cancelled_at = NOW()
     FROM warming_sequences s
     WHERE e.sequence_id = s.id AND e.lead_id = $1 AND e.status = 'active' AND s.trigger_event = $2
     RETURNING e.id`,
    [leadId, triggerEvent]
  );
  return r.rowCount;
}

/**
 * Calculate no-show risk 0-100 and update leads.no_show_risk_score.
 * Factors: days since enrolled (+10/day), no reply to last 2 warming (+30), went cold after hot (+25), previously no-showed (+40).
 */
async function calculateNoShowRisk(leadId) {
  const companyResult = await pool.query(
    `SELECT company_id FROM leads WHERE id = $1`,
    [leadId]
  );
  const companyId = companyResult.rows[0]?.company_id;
  if (!companyId) return { score: 0, risk_level: 'low' };

  let score = 0;

  const enrolled = await pool.query(
    `SELECT e.enrolled_at FROM warming_enrollments e
     JOIN warming_sequences s ON s.id = e.sequence_id
     WHERE e.lead_id = $1 AND s.trigger_event = 'call_booked' AND e.status IN ('active','completed')
     ORDER BY e.enrolled_at DESC LIMIT 1`,
    [leadId]
  );
  if (enrolled.rows[0]) {
    const days = (Date.now() - new Date(enrolled.rows[0].enrolled_at)) / (24 * 60 * 60 * 1000);
    score += Math.min(50, Math.floor(days) * 10);
  }

  const lastTwo = await pool.query(
    `SELECT id FROM warming_message_log WHERE lead_id = $1 ORDER BY sent_at DESC LIMIT 2`,
    [leadId]
  );
  if (lastTwo.rows.length >= 2) {
    const lastSent = await pool.query(
      `SELECT sent_at FROM warming_message_log WHERE lead_id = $1 ORDER BY sent_at DESC LIMIT 1`,
      [leadId]
    );
    const leadEng = await pool.query(
      `SELECT last_engagement_at FROM leads WHERE id = $1`,
      [leadId]
    );
    const lastEng = leadEng.rows[0]?.last_engagement_at;
    const lastSentAt = lastSent.rows[0]?.sent_at;
    if (!lastEng || (lastSentAt && new Date(lastEng) < new Date(lastSentAt))) {
      score += 30;
    }
  }

  const hotThenCold = await pool.query(
    `SELECT 1 FROM leads WHERE id = $1 AND (is_hot_lead = true OR intent_score >= 70) AND (last_engagement_at IS NULL OR last_engagement_at < COALESCE(updated_at, created_at) - INTERVAL '7 days')`,
    [leadId]
  );
  if (hotThenCold.rows.length) score += 25;

  const noShow = await pool.query(
    `SELECT 1 FROM appointments WHERE lead_id = $1 AND status = 'no_show' LIMIT 1`,
    [leadId]
  );
  if (noShow.rows.length) score += 40;

  score = Math.min(100, Math.max(0, score));

  await pool.query(
    `UPDATE leads SET no_show_risk_score = $2 WHERE id = $1`,
    [leadId, score]
  );

  const risk_level = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';
  return { score, risk_level };
}

/**
 * Ensure default warming sequences exist for a company (for new companies or one-time seed).
 */
async function ensureDefaultSequences(companyId) {
  const existing = await pool.query(
    `SELECT 1 FROM warming_sequences WHERE company_id = $1 LIMIT 1`,
    [companyId]
  );
  if (existing.rows.length) return;

  const seq1 = await pool.query(
    `INSERT INTO warming_sequences (company_id, name, trigger_event, is_active)
     VALUES ($1, 'Pre-Call Warming', 'call_booked', true) RETURNING id`,
    [companyId]
  );
  const s1 = seq1.rows[0].id;
  await pool.query(
    `INSERT INTO warming_steps (sequence_id, step_order, delay_minutes, message_template) VALUES
     ($1, 1, 60, 'Hey {name}! Just wanted to confirm we''re all set for our call. Looking forward to connecting with you 🙌'),
     ($1, 2, 1440, 'Hey {name}, just a reminder about our call tomorrow. If anything comes up, just let me know!'),
     ($1, 3, 1380, 'Hey {name}! Our call is in about an hour. Here''s the link: {booking_link}. See you soon!')`,
    [s1]
  );

  const seq2 = await pool.query(
    `INSERT INTO warming_sequences (company_id, name, trigger_event, is_active)
     VALUES ($1, 'No-Show Recovery', 'no_show_detected', true) RETURNING id`,
    [companyId]
  );
  const s2 = seq2.rows[0].id;
  await pool.query(
    `INSERT INTO warming_steps (sequence_id, step_order, delay_minutes, message_template) VALUES
     ($1, 1, 30, 'Hey {name}, looks like we missed each other! Totally fine — want to reschedule?'),
     ($1, 2, 1440, 'Hey {name}, still open to connecting when you''re ready. Just say the word and we''ll find a time.'),
     ($1, 3, 4320, 'Hey {name}, last follow-up from me — if you''re still interested in {company_name}, I''m here. No pressure at all.')`,
    [s2]
  );

  const seq3 = await pool.query(
    `INSERT INTO warming_sequences (company_id, name, trigger_event, is_active)
     VALUES ($1, 'Cold Lead Re-engagement', 'no_reply_72h', true) RETURNING id`,
    [companyId]
  );
  const s3 = seq3.rows[0].id;
  await pool.query(
    `INSERT INTO warming_steps (sequence_id, step_order, delay_minutes, message_template) VALUES
     ($1, 1, 0, 'Hey {name}! Just checking in — did you have any questions I can help with?'),
     ($1, 2, 1440, 'Hey {name}, I know things get busy. Happy to pick up where we left off whenever works for you.')`,
    [s3]
  );
}

/**
 * Record that a lead has replied to a follow-up. Called from manychat webhook
 * when a message comes in from a lead who has active warming enrollments.
 * Optionally detects sentiment via lightweight Claude call.
 */
async function recordLeadReply(leadId, messageText) {
  try {
    // Find the most recent unreplied warming message for this lead
    const lastMsg = await pool.query(
      `SELECT m.id, m.enrollment_id FROM warming_message_log m
       WHERE m.lead_id = $1 AND m.lead_replied = false
       ORDER BY m.sent_at DESC LIMIT 1`,
      [leadId]
    );
    if (!lastMsg.rows[0]) return null;

    // Quick sentiment detection
    let sentiment = null;
    try {
      const { claudeWithRetry } = require('../utils/claudeWithRetry');
      const { content } = await claudeWithRetry({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 20,
        messages: [{ role: 'user', content: `Classify this reply sentiment as "positive", "negative", or "neutral". Reply with ONLY the word.\n\nReply: "${messageText}"` }],
      });
      const text = (content?.[0]?.text || content?.text || '').trim().toLowerCase();
      if (['positive', 'negative', 'neutral'].includes(text)) sentiment = text;
    } catch (_) {}

    await pool.query(
      `UPDATE warming_message_log SET lead_replied = true, replied_at = NOW(), reply_sentiment = $2 WHERE id = $1`,
      [lastMsg.rows[0].id, sentiment]
    );

    return { messageLogId: lastMsg.rows[0].id, enrollmentId: lastMsg.rows[0].enrollment_id, sentiment };
  } catch (err) {
    logger.warn('[warming] recordLeadReply error:', err.message);
    return null;
  }
}

/**
 * Update daily follow-up analytics. Called after processing warming steps.
 */
async function updateDailyAnalytics(companyId, sequenceId) {
  try {
    const today = new Date().toISOString().split('T')[0];
    await pool.query(
      `INSERT INTO follow_up_analytics (company_id, sequence_id, period_date, messages_sent, replies_received, positive_replies, negative_replies, escalations)
       SELECT $1, $2, $3::date,
         COUNT(*) FILTER (WHERE m.sent_at::date = $3::date),
         COUNT(*) FILTER (WHERE m.lead_replied = true AND m.replied_at::date = $3::date),
         COUNT(*) FILTER (WHERE m.reply_sentiment = 'positive' AND m.replied_at::date = $3::date),
         COUNT(*) FILTER (WHERE m.reply_sentiment = 'negative' AND m.replied_at::date = $3::date),
         COUNT(DISTINCT e.id) FILTER (WHERE e.escalated = true AND e.status = 'active')
       FROM warming_message_log m
       JOIN warming_enrollments e ON e.id = m.enrollment_id
       WHERE e.company_id = $1 AND e.sequence_id = $2
       ON CONFLICT (company_id, sequence_id, period_date)
       DO UPDATE SET
         messages_sent = EXCLUDED.messages_sent,
         replies_received = EXCLUDED.replies_received,
         positive_replies = EXCLUDED.positive_replies,
         negative_replies = EXCLUDED.negative_replies,
         escalations = EXCLUDED.escalations`,
      [companyId, sequenceId, today]
    );
  } catch (err) {
    logger.warn('[warming] updateDailyAnalytics error:', err.message);
  }
}

/**
 * Hourly cron: enroll leads with upcoming call and no engagement in 72h into no_reply_72h sequence.
 */
async function runHourlyNoReply72hEnrollment() {
  const rows = await pool.query(
    `SELECT DISTINCT l.id AS lead_id, l.company_id
     FROM leads l
     INNER JOIN appointments a ON a.lead_id = l.id AND a.status = 'scheduled' AND a.start_at > NOW()
     WHERE (l.last_engagement_at IS NULL OR l.last_engagement_at < NOW() - INTERVAL '72 hours')
     AND NOT EXISTS (
       SELECT 1 FROM warming_enrollments e
       JOIN warming_sequences s ON s.id = e.sequence_id
       WHERE e.lead_id = l.id AND s.trigger_event = 'no_reply_72h' AND e.status IN ('active', 'completed')
     )`
  );
  let enrolled = 0;
  for (const r of rows.rows || []) {
    try {
      const result = await enrollLead(r.lead_id, r.company_id, 'no_reply_72h');
      if (result.enrolled) enrolled += result.enrolled;
    } catch (err) {
      logger.error('[warming] hourly no_reply_72h enroll error:', err.message);
    }
  }
  if (enrolled > 0) logger.info('[warming] hourly no_reply_72h enrolled', enrolled, 'lead(s)');
  return enrolled;
}

module.exports = {
  enrollLead,
  enrollLeadInSequence,
  processWarmingStep,
  cancelEnrollment,
  calculateNoShowRisk,
  ensureDefaultSequences,
  runHourlyNoReply72hEnrollment,
  recordLeadReply,
  updateDailyAnalytics,
  getLeadActiveWindow,
  getQueue,
  getConnection,
  QUEUE_NAME,
};
