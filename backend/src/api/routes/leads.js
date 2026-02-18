const express = require('express');
const router = express.Router({ mergeParams: true });
const { leadRepository } = require('../../../db/repositories');

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
