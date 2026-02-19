-- Add scrape tracking columns to chatbot_company_info (safe to run multiple times)

ALTER TABLE chatbot_company_info ADD COLUMN IF NOT EXISTS scrape_status TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE chatbot_company_info ADD COLUMN IF NOT EXISTS scrape_started_at TIMESTAMPTZ;
ALTER TABLE chatbot_company_info ADD COLUMN IF NOT EXISTS scrape_finished_at TIMESTAMPTZ;
ALTER TABLE chatbot_company_info ADD COLUMN IF NOT EXISTS scrape_error TEXT;
ALTER TABLE chatbot_company_info ADD COLUMN IF NOT EXISTS scraped_summary TEXT;
