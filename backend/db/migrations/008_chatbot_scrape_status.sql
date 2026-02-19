-- Add scrape status and result columns to chatbot_company_info

ALTER TABLE chatbot_company_info
  ADD COLUMN IF NOT EXISTS scrape_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (scrape_status IN ('idle', 'queued', 'running', 'summarizing', 'done', 'error')),
  ADD COLUMN IF NOT EXISTS scrape_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS scrape_finished_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS scrape_error TEXT,
  ADD COLUMN IF NOT EXISTS scraped_summary TEXT;
