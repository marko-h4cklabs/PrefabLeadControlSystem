const express = require('express');
const router = express.Router();
const { companyRepository } = require('../../../db/repositories');
const { tenantMiddleware, requireCompanyMatch } = require('../middleware/tenant');
const { requireRole } = require('../middleware/auth');
const { errorJson } = require('../middleware/errors');
const fieldsRouter = require('./fields');
const leadsRouter = require('./leads');

router.use(tenantMiddleware);

router.get('/:id', requireCompanyMatch, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const company = await companyRepository.findById(req.tenantId);
    if (!company) {
      return errorJson(res, 404, 'NOT_FOUND', 'Company not found');
    }
    res.json(company);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.patch('/:id', requireCompanyMatch, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const company = await companyRepository.update(req.tenantId, req.body);
    if (!company) {
      return errorJson(res, 404, 'NOT_FOUND', 'Company not found');
    }
    res.json(company);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.use('/:id/fields', requireCompanyMatch, requireRole('owner', 'admin'), fieldsRouter);
router.use('/:id/leads', requireCompanyMatch, requireRole('owner', 'admin', 'member'), leadsRouter);

// Compat alias: POST /api/companies/:companyId/book-slot -> shared book-slot handler
router.post('/:id/book-slot', requireCompanyMatch, async (req, res) => {
  const { handleBookSlot } = require('./scheduling');
  req.tenantId = req.tenantId || req.params.id;
  return handleBookSlot(req, res);
});

module.exports = router;
