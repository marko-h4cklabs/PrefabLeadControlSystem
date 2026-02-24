/**
 * Pre-call warming and no-show reduction.
 * Enrolls leads in sequences, processes steps via BullMQ, cancels on reply, calculates no-show risk.
 */

const IORedis = require('ioredis');
const { Queue } = require('bullmq');
const { pool } = require('../../db');
const { leadRepository, companyRepository } = require('../../db/repositories');
const { sendInstagramMessage } = require('./manychatService');

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
        removeOnFail: { age: 86400 },
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
      console.error('[warming] schedule first step failed:', err.message);
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
 * Process a single warming step (called by BullMQ worker).
 * Sends message via ManyChat, logs, schedules next step or marks completed.
 */
async function processWarmingStep(enrollmentId, stepId) {
  const enrollment = await pool.query(
    `SELECT id, lead_id, sequence_id, company_id, status, current_step
     FROM warming_enrollments WHERE id = $1`,
    [enrollmentId]
  );
  const enr = enrollment.rows[0];
  if (!enr || enr.status !== 'active') return;

  const step = await pool.query(
    `SELECT id, step_order, delay_minutes, message_template FROM warming_steps WHERE id = $1`,
    [stepId]
  );
  const st = step.rows[0];
  if (!st) return;

  const lead = await leadRepository.findById(enr.company_id, enr.lead_id);
  if (!lead) return;
  if (lead.status === 'qualified' || lead.status === 'disqualified') return;

  let company = {};
  try {
    const companyRow = await pool.query(
      `SELECT name, booking_url FROM companies WHERE id = $1`,
      [enr.company_id]
    );
    company = companyRow.rows[0] || {};
  } catch (_) {
    /* booking_url column may not exist yet; use empty booking_link */
  }
  const bookingUrl = company.booking_url != null ? String(company.booking_url) : '';
  let message = interpolate(st.message_template, {
    name: lead.name || lead.external_id || 'there',
    company_name: company.name || 'us',
    booking_link: bookingUrl,
  });
  message = message.replace(/\{booking_link\}/gi, bookingUrl).trim();

  let manychatResponse = null;
  try {
    const mcRow = await pool.query(
      `SELECT manychat_api_key FROM companies WHERE id = $1`,
      [enr.company_id]
    );
    const apiKey = mcRow.rows[0]?.manychat_api_key;
    if (apiKey && lead.external_id) {
      manychatResponse = await sendInstagramMessage(lead.external_id, message, apiKey);
    }
  } catch (err) {
    console.error('[warming] send message failed:', err.message);
    manychatResponse = { error: err.message };
  }

  await pool.query(
    `INSERT INTO warming_message_log (enrollment_id, lead_id, step_id, message_sent, manychat_response)
     VALUES ($1, $2, $3, $4, $5)`,
    [enrollmentId, enr.lead_id, stepId, message, manychatResponse ? JSON.stringify(manychatResponse) : null]
  );

  const nextSteps = await pool.query(
    `SELECT id, step_order, delay_minutes FROM warming_steps
     WHERE sequence_id = $1 AND step_order > $2 ORDER BY step_order ASC`,
    [enr.sequence_id, st.step_order]
  );

  if (nextSteps.rows.length > 0) {
    const next = nextSteps.rows[0];
    await pool.query(
      `UPDATE warming_enrollments SET current_step = $2 WHERE id = $1`,
      [enrollmentId, next.step_order]
    );
    const delayMs = Math.max(0, (next.delay_minutes || 0) * 60 * 1000);
    await getQueue().add(
      'warming_step',
      { enrollmentId, stepId: next.id },
      { jobId: `warming-${enrollmentId}-${next.id}`, delay: delayMs }
    );
  } else {
    await pool.query(
      `UPDATE warming_enrollments SET status = 'completed', completed_at = NOW() WHERE id = $1`,
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
      console.error('[warming] hourly no_reply_72h enroll error:', err.message);
    }
  }
  if (enrolled > 0) console.info('[warming] hourly no_reply_72h enrolled', enrolled, 'lead(s)');
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
  getQueue,
  getConnection,
  QUEUE_NAME,
};
