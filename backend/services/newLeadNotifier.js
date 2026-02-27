/**
 * Handles notifications for new lead creation: in-app + email.
 * Called from lead creation flows. Does not block; errors are caught.
 */

const logger = require('../src/lib/logger');
const { notificationRepository, notificationSettingsRepository, companyRepository } = require('../db/repositories');
const { sendNewLeadEmail } = require('./emailService');
const { getCollectedInfosForLead } = require('./collectedInfoService');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(s) {
  return typeof s === 'string' && s.trim().length > 0 && EMAIL_REGEX.test(s.trim());
}

/**
 * Get recipient emails: from settings, or fallback (company contact, user email).
 */
async function getRecipientEmails(companyId, settings, fallbackEmails = []) {
  const recipients = Array.isArray(settings.email_recipients) ? settings.email_recipients : [];
  const valid = recipients.filter((e) => isValidEmail(e)).map((e) => e.trim().toLowerCase());
  if (valid.length > 0) return valid;

  const fallback = fallbackEmails.filter((e) => isValidEmail(e)).map((e) => e.trim().toLowerCase());
  if (fallback.length > 0) return fallback;

  try {
    const company = await companyRepository.findById(companyId);
    if (company?.contact_email && isValidEmail(company.contact_email)) {
      return [company.contact_email.trim().toLowerCase()];
    }
  } catch {
    // ignore
  }
  return [];
}

/**
 * Notify on new lead: in-app (inbox only) + email (if enabled and source toggle on).
 * @param {string} companyId
 * @param {object} lead - created lead
 * @param {object} [opts] - { userEmail?: string } for fallback
 */
async function notifyNewLeadCreated(companyId, lead, opts = {}) {
  const source = lead.source ?? 'inbox';

  if (source === 'inbox') {
    const leadName = lead.name ?? lead.external_id ?? 'Unknown';
    const body = `${leadName} (${lead.channel})`;
    await notificationRepository.create(companyId, {
      leadId: lead.id,
      type: 'new_lead',
      title: 'New inquiry',
      body,
      url: `/inbox/${lead.id}`,
    }).catch(() => {});
  }

  let settings;
  try {
    settings = await notificationSettingsRepository.get(companyId);
  } catch (err) {
    logger.error('[newLeadNotifier] Failed to load settings:', err.message);
    return;
  }

  if (!settings.email_enabled) return;

  const inboxEnabled = settings.notify_new_inquiry_inbox ?? true;
  const simEnabled = settings.notify_new_inquiry_simulation ?? false;
  if (source === 'inbox' && !inboxEnabled) return;
  if (source === 'simulation' && !simEnabled) return;

  const fallbackEmails = opts.userEmail ? [opts.userEmail] : [];
  const recipients = await getRecipientEmails(companyId, settings, fallbackEmails);
  if (recipients.length === 0) return;

  let collectedInfos = [];
  try {
    collectedInfos = await getCollectedInfosForLead(companyId, lead.id);
  } catch (err) {
    logger.error('[newLeadNotifier] Failed to load collected info:', err.message);
  }

  const baseUrl = process.env.FRONTEND_ORIGIN ? process.env.FRONTEND_ORIGIN.split(',')[0]?.trim() : null;
  await sendNewLeadEmail(recipients, lead, { baseUrl, collectedInfos });
}

module.exports = { notifyNewLeadCreated };
