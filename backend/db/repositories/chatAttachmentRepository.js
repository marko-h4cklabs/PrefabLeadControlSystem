const crypto = require('crypto');
const { pool } = require('../index');

const FIELD_NAME = 'pictures';

function generatePublicToken() {
  return crypto.randomBytes(24).toString('hex');
}

async function create(companyId, leadId, data) {
  const { mimeType, fileName, byteSize, buffer, conversationId = null } = data;
  const publicToken = generatePublicToken();
  const result = await pool.query(
    `INSERT INTO chat_attachments (company_id, lead_id, conversation_id, field_name, mime_type, file_name, byte_size, data, public_token)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, company_id, lead_id, conversation_id, field_name, mime_type, file_name, byte_size, public_token, created_at`,
    [companyId, leadId, conversationId, FIELD_NAME, mimeType, fileName ?? null, byteSize, buffer, publicToken]
  );
  return result.rows[0];
}

async function findById(id) {
  const result = await pool.query(
    'SELECT id, company_id, lead_id, conversation_id, field_name, mime_type, file_name, byte_size, data, public_token, created_at FROM chat_attachments WHERE id = $1',
    [id]
  );
  return result.rows[0] ?? null;
}

async function findByPublicToken(token) {
  const result = await pool.query(
    'SELECT id, company_id, lead_id, mime_type, data, public_token FROM chat_attachments WHERE public_token = $1',
    [token]
  );
  return result.rows[0] ?? null;
}

async function getByLeadId(companyId, leadId) {
  const result = await pool.query(
    `SELECT id, company_id, lead_id, conversation_id, field_name, mime_type, file_name, byte_size, public_token, created_at
     FROM chat_attachments
     WHERE company_id = $1 AND lead_id = $2
     ORDER BY created_at ASC`,
    [companyId, leadId]
  );
  return result.rows;
}

/**
 * For future webhook ingestion: insert attachment by external URL without bytes.
 * Requires migration to add external_url column; for now throws.
 */
async function createFromExternalUrl(companyId, leadId, data) {
  throw new Error('createFromExternalUrl: requires external_url column migration');
}

module.exports = {
  create,
  findById,
  findByPublicToken,
  getByLeadId,
  createFromExternalUrl,
  FIELD_NAME,
};
