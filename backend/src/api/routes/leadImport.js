/**
 * Lead import (CSV, manual) and export (CSV). Mount under /api/leads.
 */
const logger = require('../../lib/logger');
const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const router = express.Router();
const { pool } = require('../../../db');
const { leadRepository } = require('../../../db/repositories');
const { errorJson } = require('../middleware/errors');

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const COLUMN_MAP = {
  name: ['name', 'full name', 'fullname', 'contact name'],
  email: ['email', 'e-mail', 'mail'],
  phone: ['phone', 'telephone', 'mobile', 'tel'],
  instagram_username: ['instagram_username', 'instagram', 'ig', 'username'],
  notes: ['notes', 'note', 'comments', 'message'],
  source: ['source', 'origin', 'channel'],
};

function normalizeHeader(h) {
  return String(h ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function mapRowToLead(row) {
  const lead = { name: null, email: null, phone: null, instagram_username: null, notes: null, source: null };
  const keys = Object.keys(row || {});
  for (const key of keys) {
    const n = normalizeHeader(key);
    const val = row[key] != null ? String(row[key]).trim() : '';
    if (COLUMN_MAP.name.includes(n)) lead.name = val || lead.name;
    else if (COLUMN_MAP.email.includes(n)) lead.email = val || lead.email;
    else if (COLUMN_MAP.phone.includes(n)) lead.phone = val || lead.phone;
    else if (COLUMN_MAP.instagram_username.includes(n)) lead.instagram_username = val || lead.instagram_username;
    else if (COLUMN_MAP.notes.includes(n)) lead.notes = val || lead.notes;
    else if (COLUMN_MAP.source.includes(n)) lead.source = val || lead.source;
  }
  return lead;
}

async function createImportedLead(companyId, row, errors) {
  const lead = mapRowToLead(row);
  if (!lead.name && !lead.email && !lead.instagram_username) {
    errors.push('Row missing name, email, and instagram_username');
    return null;
  }
  try {
    const created = await leadRepository.create(companyId, {
      channel: 'imported',
      source: 'imported',
      name: lead.name || lead.email || lead.instagram_username || 'Imported',
      external_id: lead.email || lead.instagram_username || `import-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    });
    await leadRepository.update(companyId, created.id, { pipeline_stage: 'new_inquiry' });
    if (lead.notes) {
      await pool.query(
        `UPDATE leads SET conversation_summary = $2 WHERE id = $1 AND company_id = $3`,
        [created.id, lead.notes.slice(0, 4000), companyId]
      ).catch(() => {});
    }
    return created;
  } catch (err) {
    errors.push(err.message || 'Create failed');
    return null;
  }
}

// POST /api/leads/import/csv
router.post('/import/csv', csvUpload.single('file'), async (req, res) => {
  try {
    const companyId = req.tenantId;
    const file = req.file;
    if (!file || !file.buffer) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'CSV file required');
    }
    let records;
    try {
      records = parse(file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
    } catch (e) {
      return errorJson(res, 400, 'VALIDATION_ERROR', 'Invalid CSV: ' + (e.message || 'parse error'));
    }
    const errors = [];
    let imported = 0;
    for (const row of records) {
      const created = await createImportedLead(companyId, row, errors);
      if (created) imported++;
    }
    return res.json({ imported, failed: records.length - imported, errors: errors.slice(0, 50) });
  } catch (err) {
    logger.error('[leadImport] csv:', err.message);
    return errorJson(res, 500, 'INTERNAL_ERROR', 'Import failed');
  }
});

// POST /api/leads/import/manual
router.post('/import/manual', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const leads = Array.isArray(req.body?.leads) ? req.body.leads : [];
    const errors = [];
    let imported = 0;
    for (const row of leads) {
      const created = await createImportedLead(companyId, row, errors);
      if (created) imported++;
    }
    return res.json({ imported, failed: leads.length - imported, errors: errors.slice(0, 50) });
  } catch (err) {
    logger.error('[leadImport] manual:', err.message);
    return errorJson(res, 500, 'INTERNAL_ERROR', 'Import failed');
  }
});

// GET /api/leads/export/csv
router.get('/export/csv', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const r = await pool.query(
      `SELECT name, external_id, channel, status, pipeline_stage, intent_score, budget_detected, deal_value, created_at
       FROM leads
       WHERE company_id = $1
       ORDER BY created_at DESC`,
      [companyId]
    );
    const rows = r.rows || [];
    const header = 'name,email,phone,instagram_username,status,pipeline_stage,intent_score,budget_detected,deal_value,created_at';
    const escape = (v) => {
      const s = v != null ? String(v) : '';
      if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const lines = [header, ...rows.map((row) => {
      const email = row.channel === 'instagram' ? '' : (row.external_id || '');
      const instagram_username = row.channel === 'instagram' ? (row.external_id || '') : '';
      return [row.name, email, '', instagram_username, row.status, row.pipeline_stage, row.intent_score, row.budget_detected, row.deal_value, row.created_at].map(escape).join(',');
    })];
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', 'attachment; filename=leads.csv');
    return res.send(lines.join('\n'));
  } catch (err) {
    logger.error('[leadImport] export:', err.message);
    return errorJson(res, 500, 'INTERNAL_ERROR', 'Export failed');
  }
});

module.exports = router;
