const express = require('express');
const router = express.Router();
const { webhookEventsRepository, leadRepository, notificationRepository } = require('../../../db/repositories');
const { webhookAuthMiddleware } = require('../middleware/webhookAuth');
const { notifyNewLead } = require('../../services/notifier');
const { errorJson } = require('../middleware/errors');

const ALLOWED_CHANNELS = new Set(['instagram', 'messenger', 'whatsapp', 'telegram', 'email']);

router.post('/:channel/webhook', webhookAuthMiddleware, async (req, res) => {
  try {
    const { channel } = req.params;
    if (!ALLOWED_CHANNELS.has(channel)) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: `Invalid channel. Allowed: ${[...ALLOWED_CHANNELS].join(', ')}` },
      });
    }

    const payload = typeof req.body === 'object' && req.body !== null ? req.body : {};
    const companyId = req.tenantId;

    await webhookEventsRepository.create(companyId, channel, payload);

    const externalId = payload.external_id;
    let lead = null;

    if (externalId != null && String(externalId).trim() !== '') {
      const existing = await leadRepository.findByCompanyChannelExternalId(companyId, channel, String(externalId), 'inbox');
      if (existing) {
        lead = await leadRepository.update(companyId, existing.id, {});
      } else {
        lead = await leadRepository.create(companyId, {
          channel,
          external_id: String(externalId),
          source: 'inbox',
        });
        notifyNewLead(lead, 'webhook');
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
    }

    res.status(202).json({
      stored: true,
      lead_id: lead?.id ?? null,
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: { code: 'CONFLICT', message: 'Lead already exists for this channel/external_id' },
      });
    }
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

module.exports = router;
