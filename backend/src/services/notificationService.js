const { notificationRepository } = require('../../db/repositories');

async function createNotification(companyId, type, title, message, leadId = null, metadata = {}) {
  await notificationRepository.create(companyId, {
    leadId,
    type,
    title,
    body: message,
    message,
    url: null,
    metadata: typeof metadata === 'object' ? metadata : {},
  });
}

module.exports = { createNotification };
