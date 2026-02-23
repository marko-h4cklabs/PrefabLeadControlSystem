-- Migration: 033_companies_instagram_account_id
-- Add Instagram/Meta integration columns to companies for webhook routing

ALTER TABLE companies ADD COLUMN IF NOT EXISTS instagram_account_id TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS meta_page_access_token TEXT;

CREATE INDEX IF NOT EXISTS idx_companies_instagram_account_id
  ON companies(instagram_account_id) WHERE instagram_account_id IS NOT NULL;
