/**
 * Parse a .docx or .xlsx file buffer and extract its text content.
 * Dependencies are lazy-loaded so the server starts even if they aren't installed.
 * @param {Buffer} buffer - File buffer from multer memoryStorage
 * @param {string} mimetype - MIME type of the uploaded file
 * @param {string} originalname - Original filename
 * @returns {string} Extracted text content
 */
async function parseDocument(buffer, mimetype, originalname) {
  const ext = (originalname || '').split('.').pop()?.toLowerCase();

  if (mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || ext === 'docx') {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return (result.value || '').trim();
  }

  if (
    mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimetype === 'application/vnd.ms-excel' ||
    ext === 'xlsx' ||
    ext === 'xls'
  ) {
    const XLSX = require('xlsx');
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheets = [];
    for (const name of workbook.SheetNames) {
      const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[name]);
      if (csv.trim()) {
        sheets.push(`--- Sheet: ${name} ---\n${csv.trim()}`);
      }
    }
    return sheets.join('\n\n');
  }

  throw new Error(`Unsupported file type: ${mimetype || ext}`);
}

module.exports = { parseDocument };
