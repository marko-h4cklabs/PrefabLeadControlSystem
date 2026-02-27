/**
 * Placeholder notifier for internal events.
 * Logs NEW_LEAD events. No external sending yet.
 */
const logger = require('../lib/logger');
function notifyNewLead(lead, source = 'webhook') {
  logger.info('[NOTIFIER] NEW_LEAD', {
    leadId: lead?.id,
    channel: lead?.channel,
    externalId: lead?.external_id,
    source,
    at: new Date().toISOString(),
  });
}

module.exports = { notifyNewLead };
