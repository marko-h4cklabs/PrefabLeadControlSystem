const { pool } = require('../index');

async function upsert(companyId, page) {
  const { url, title, content_markdown, content_text, content_hash } = page;
  await pool.query(
    `INSERT INTO chatbot_scraped_pages (company_id, url, title, content_markdown, content_text, content_hash, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (company_id, url) DO UPDATE SET
       title = EXCLUDED.title,
       content_markdown = EXCLUDED.content_markdown,
       content_text = EXCLUDED.content_text,
       content_hash = EXCLUDED.content_hash,
       updated_at = NOW()`,
    [companyId, url, title ?? null, content_markdown ?? null, content_text ?? null, content_hash ?? null]
  );
}

async function upsertMany(companyId, pages) {
  const client = await pool.connect();
  try {
    for (const p of pages) {
      await client.query(
        `INSERT INTO chatbot_scraped_pages (company_id, url, title, content_markdown, content_text, content_hash, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (company_id, url) DO UPDATE SET
           title = EXCLUDED.title,
           content_markdown = EXCLUDED.content_markdown,
           content_text = EXCLUDED.content_text,
           content_hash = EXCLUDED.content_hash,
           updated_at = NOW()`,
        [
          companyId,
          p.url,
          p.title ?? null,
          p.content_markdown ?? null,
          p.content_text ?? null,
          p.content_hash ?? null,
        ]
      );
    }
  } finally {
    client.release();
  }
}

async function listByCompany(companyId) {
  const result = await pool.query(
    'SELECT url, title, content_markdown, content_text, content_hash, created_at FROM chatbot_scraped_pages WHERE company_id = $1 ORDER BY created_at ASC',
    [companyId]
  );
  return result.rows;
}

async function deleteByCompany(companyId) {
  await pool.query('DELETE FROM chatbot_scraped_pages WHERE company_id = $1', [companyId]);
}

module.exports = { upsert, upsertMany, listByCompany, deleteByCompany };
