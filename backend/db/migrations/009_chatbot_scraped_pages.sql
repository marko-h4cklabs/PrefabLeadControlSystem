-- Scraped pages storage for crawl results

CREATE TABLE IF NOT EXISTS chatbot_scraped_pages (
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    url             TEXT NOT NULL,
    title           TEXT,
    content_markdown TEXT,
    content_text    TEXT,
    content_hash    TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_id, url)
);

CREATE INDEX IF NOT EXISTS idx_chatbot_scraped_pages_company ON chatbot_scraped_pages(company_id);
