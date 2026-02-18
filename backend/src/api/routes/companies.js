const express = require('express');
const router = express.Router();
const { companyRepository } = require('../../../db/repositories');
const { tenantMiddleware, requireCompanyMatch } = require('../middleware/tenant');
const fieldsRouter = require('./fields');
const leadsRouter = require('./leads');

router.use(tenantMiddleware);

router.get('/:id', requireCompanyMatch, async (req, res) => {
  try {
    const company = await companyRepository.findById(req.params.id);
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }
    res.json(company);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', requireCompanyMatch, async (req, res) => {
  try {
    const company = await companyRepository.update(req.params.id, req.body);
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }
    res.json(company);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.use('/:id/fields', requireCompanyMatch, fieldsRouter);
router.use('/:id/leads', requireCompanyMatch, leadsRouter);

module.exports = router;
