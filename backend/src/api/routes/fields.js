const express = require('express');
const router = express.Router({ mergeParams: true });
const { qualificationFieldRepository } = require('../../../db/repositories');

router.get('/', async (req, res) => {
  try {
    const companyId = req.params.id;
    const fields = await qualificationFieldRepository.findAll(companyId);
    res.json(fields);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const companyId = req.params.id;
    const { field_name, field_key, field_type, units, required, scoring_weight, dependencies, validation_rules, display_order } = req.body;
    if (!field_name || !field_key || !field_type) {
      return res.status(400).json({ error: 'field_name, field_key, and field_type are required' });
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
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:fieldId', async (req, res) => {
  try {
    const companyId = req.params.id;
    const field = await qualificationFieldRepository.update(companyId, req.params.fieldId, req.body);
    if (!field) {
      return res.status(404).json({ error: 'Field not found' });
    }
    res.json(field);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:fieldId', async (req, res) => {
  try {
    const companyId = req.params.id;
    const deleted = await qualificationFieldRepository.remove(companyId, req.params.fieldId);
    if (!deleted) {
      return res.status(404).json({ error: 'Field not found' });
    }
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
