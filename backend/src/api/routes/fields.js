const express = require('express');
const router = express.Router({ mergeParams: true });
const { qualificationFieldRepository } = require('../../../db/repositories');
const { errorJson } = require('../middleware/errors');

router.get('/', async (req, res) => {
  try {
    const fields = await qualificationFieldRepository.findAll(req.tenantId);
    res.json(fields);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.post('/', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const { field_name, field_key, field_type, units, required, scoring_weight, dependencies, validation_rules, display_order } = req.body;
    if (!field_name || !field_key || !field_type) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'field_name, field_key, and field_type are required' } });
    }
    const field = await qualificationFieldRepository.create(companyId, {
      field_name,
      field_key,
      field_type,
      units,
      required,
      scoring_weight,
      dependencies,
      validation_rules,
      display_order,
    });
    res.status(201).json(field);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.patch('/:fieldId', async (req, res) => {
  try {
    const field = await qualificationFieldRepository.update(req.tenantId, req.params.fieldId, req.body);
    if (!field) {
      return errorJson(res, 404, 'NOT_FOUND', 'Field not found');
    }
    res.json(field);
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.delete('/:fieldId', async (req, res) => {
  try {
    const deleted = await qualificationFieldRepository.remove(req.tenantId, req.params.fieldId);
    if (!deleted) {
      return errorJson(res, 404, 'NOT_FOUND', 'Field not found');
    }
    res.status(204).send();
  } catch (err) {
    errorJson(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

module.exports = router;
