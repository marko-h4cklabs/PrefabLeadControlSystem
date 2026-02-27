/**
 * Log lead activities for CRM timeline.
 * Fire-and-forget; errors are caught.
 */

const logger = require('../src/lib/logger');
const { leadActivitiesRepository } = require('../db/repositories');

async function logLeadActivity({
  companyId,
  leadId,
  eventType,
  actorType = 'system',
  actorUserId = null,
  source = null,
  channel = null,
  metadata = {},
}) {
  try {
    await leadActivitiesRepository.create({
      companyId,
      leadId,
      eventType,
      actorType,
      actorUserId,
      source,
      channel,
      metadata: typeof metadata === 'object' ? metadata : {},
    });
  } catch (err) {
    logger.error('[activityLogger] Failed to log:', err.message);
  }
}

module.exports = { logLeadActivity };
