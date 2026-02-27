/**
 * BullMQ Worker for follow-up queue.
 * Processes scheduled outreach jobs: no_reply, post_quote, cold_lead, custom.
 */

const logger = require('../src/lib/logger');
const { Worker } = require('bullmq');
const queueService = require('./queueService');
const {
  leadRepository,
  conversationRepository,
  appointmentRepository,
} = require('../db/repositories');
const aiReplyService = require('./aiReplyService');
const { logLeadActivity } = require('./activityLogger');

const CONCURRENCY = 5;

let worker = null;

function hasUserRepliedSince(leadId, scheduledAt) {
  return conversationRepository.getByLeadId(leadId).then((conv) => {
    if (!conv || !Array.isArray(conv.messages)) return false;
    const userMsgs = conv.messages.filter((m) => m && m.role === 'user');
    return userMsgs.some((m) => {
      const ts = m.timestamp;
      if (!ts) return false;
      return new Date(ts) > new Date(scheduledAt);
    });
  });
}

async function hasAppointmentBooked(companyId, leadId) {
  const count = await appointmentRepository.count(companyId, {
    leadId,
    status: 'scheduled',
  });
  return count > 0;
}

async function processJob(job) {
  const { leadId, companyId, type, scheduledAt } = job.data;
  logger.info(`[follow-up] processing job type=${type} for leadId=${leadId}`);

  let lead;
  try {
    lead = await leadRepository.findById(companyId, leadId);
  } catch (err) {
    logger.error('[follow-up] fetch lead error:', err.message);
    return;
  }

  if (!lead) {
    logger.info('[follow-up] lead not found, skipping');
    return;
  }

  if (lead.status === 'qualified' || lead.status === 'disqualified') {
    logger.info('[follow-up] lead status is qualified/disqualified, skipping');
    return;
  }

  try {
    switch (type) {
      case 'no_reply': {
        const replied = await hasUserRepliedSince(leadId, scheduledAt || 0);
        if (replied) {
          logger.info('[follow-up] lead replied since scheduled, skipping');
          return;
        }
        let conversation = await conversationRepository.getByLeadId(leadId);
        if (!conversation) {
          conversation = await conversationRepository.createIfNotExists(leadId, companyId);
        }
        await conversationRepository.appendMessage(leadId, 'user', '[Follow-up: no reply - re-engagement]');
        const result = await aiReplyService.generateAiReply(companyId, leadId);
        await conversationRepository.appendMessage(leadId, 'assistant', result.assistant_message);
        const merged = result.parsed_fields ?? result.field_updates ?? {};
        const curr = await conversationRepository.getByLeadId(leadId);
        if (JSON.stringify(merged) !== JSON.stringify(curr?.parsed_fields ?? {}) && Object.keys(merged).length > 0) {
          await conversationRepository.updateParsedFields(leadId, merged);
        }
        await logLeadActivity({
          companyId,
          leadId,
          eventType: 'follow_up_sent',
          actorType: 'system',
          source: 'follow_up',
          channel: lead.channel,
          metadata: { type: 'no_reply' },
        }).catch(() => {});
        break;
      }

      case 'post_quote': {
        const booked = await hasAppointmentBooked(companyId, leadId);
        if (booked) {
          logger.info('[follow-up] appointment already booked, skipping');
          return;
        }
        let conv = await conversationRepository.getByLeadId(leadId);
        if (!conv) conv = await conversationRepository.createIfNotExists(leadId, companyId);
        await conversationRepository.appendMessage(leadId, 'user', '[Follow-up: post-quote booking nudge]');
        const res = await aiReplyService.generateAiReply(companyId, leadId);
        await conversationRepository.appendMessage(leadId, 'assistant', res.assistant_message);
        const mp = res.parsed_fields ?? res.field_updates ?? {};
        const c = await conversationRepository.getByLeadId(leadId);
        if (JSON.stringify(mp) !== JSON.stringify(c?.parsed_fields ?? {}) && Object.keys(mp).length > 0) {
          await conversationRepository.updateParsedFields(leadId, mp);
        }
        await logLeadActivity({
          companyId,
          leadId,
          eventType: 'follow_up_sent',
          actorType: 'system',
          source: 'follow_up',
          channel: lead.channel,
          metadata: { type: 'post_quote' },
        }).catch(() => {});
        break;
      }

      case 'cold_lead': {
        if ((lead.score ?? 0) > 40) {
          logger.info('[follow-up] lead score > 40, skipping cold_lead');
          return;
        }
        let c2 = await conversationRepository.getByLeadId(leadId);
        if (!c2) c2 = await conversationRepository.createIfNotExists(leadId, companyId);
        await conversationRepository.appendMessage(leadId, 'user', '[Follow-up: cold lead re-engagement]');
        const r2 = await aiReplyService.generateAiReply(companyId, leadId);
        await conversationRepository.appendMessage(leadId, 'assistant', r2.assistant_message);
        const mp2 = r2.parsed_fields ?? r2.field_updates ?? {};
        const c3 = await conversationRepository.getByLeadId(leadId);
        if (JSON.stringify(mp2) !== JSON.stringify(c3?.parsed_fields ?? {}) && Object.keys(mp2).length > 0) {
          await conversationRepository.updateParsedFields(leadId, mp2);
        }
        await logLeadActivity({
          companyId,
          leadId,
          eventType: 'follow_up_sent',
          actorType: 'system',
          source: 'follow_up',
          channel: lead.channel,
          metadata: { type: 'cold_lead' },
        }).catch(() => {});
        break;
      }

      case 'custom': {
        const message = job.data.message;
        if (!message || typeof message !== 'string') {
          logger.info('[follow-up] custom job missing message, skipping');
          return;
        }
        let c4 = await conversationRepository.getByLeadId(leadId);
        if (!c4) c4 = await conversationRepository.createIfNotExists(leadId, companyId);
        await conversationRepository.appendMessage(leadId, 'assistant', message);
        await logLeadActivity({
          companyId,
          leadId,
          eventType: 'follow_up_sent',
          actorType: 'system',
          source: 'follow_up',
          channel: lead.channel,
          metadata: { type: 'custom' },
        }).catch(() => {});
        break;
      }

      default:
        logger.info('[follow-up] unknown type', type);
    }
  } catch (err) {
    logger.error('[follow-up] job processing error:', err.message);
    // Do not throw - prevents job from blocking the queue
  }
}

function start() {
  if (worker) return;
  const connection = queueService.getConnection();
  worker = new Worker(
    queueService.QUEUE_NAME,
    async (job) => {
      await processJob(job);
    },
    {
      connection,
      concurrency: CONCURRENCY,
    }
  );

  worker.on('error', (err) => {
    logger.error('[follow-up worker] error:', err.message);
  });

  worker.on('failed', async (job, err) => {
    logger.error('[follow-up worker] job failed:', job?.id, err?.message);
    if (job && job.attemptsMade >= (job.opts?.attempts || 2)) {
      const { sendAdminAlert } = require('../src/services/adminAlertService');
      sendAdminAlert(
        `dlq:followup:${job.id}`,
        'Follow-up job permanently failed',
        { jobId: job.id, leadId: job.data?.leadId, type: job.data?.type, error: err?.message }
      ).catch(() => {});
    }
  });

  logger.info('[follow-up worker] started, concurrency=', CONCURRENCY);
}

async function stop() {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info('[follow-up worker] stopped');
  }
}

module.exports = { start, stop };
