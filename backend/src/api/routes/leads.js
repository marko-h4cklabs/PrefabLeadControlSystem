const express = require('express');
const router = express.Router({ mergeParams: true });
const { leadRepository } = require('../../../db/repositories');

const VALID_CHANNELS = ['instagram', 'messenger', 'email'];

router.get('/', async (req, res) => {
  try {
    const companyId = req.params.id;
    const { status, limit, offset } = req.query;
    const leads = await leadRepository.findAll(companyId, {
      status: status || undefined,
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });
    const total = await leadRepository.count(companyId, { status: status || undefined });
    res.json({ leads, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const companyId = req.params.id;
    const { channel, external_id } = req.body;
    if (!channel) {
      return res.status(400).json({ error: 'channel is required' });
    }
    if (!VALID_CHANNELS.includes(channel)) {
      return res.status(400).json({ error: 'channel must be one of: instagram, messenger, email' });
    }
    const lead = await leadRepository.create(companyId, {
      channel,
      external_id: external_id ?? null,
    });
    res.status(201).json(lead);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Lead already exists for this channel/external_id' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.get('/:leadId', async (req, res) => {
  try {
    const companyId = req.params.id;
    const lead = await leadRepository.findById(companyId, req.params.leadId);
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    res.json(lead);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:leadId/conversation', async (req, res) => {
  try {
    const companyId = req.params.id;
    const leadId = req.params.leadId;
    const lead = await leadRepository.findById(companyId, leadId);
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    res.json({
      lead_id: leadId,
      messages: [],
      parsed_fields: {},
      current_step: 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:leadId', async (req, res) => {
  try {
    const companyId = req.params.id;
    const { assigned_sales } = req.body;
    const lead = await leadRepository.update(companyId, req.params.leadId, { assigned_sales });
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    res.json(lead);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
