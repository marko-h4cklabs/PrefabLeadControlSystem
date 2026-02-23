-- Migration 036: ManyChat integration fields

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS manychat_api_key TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS manychat_page_id TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_companies_manychat_page_id
  ON companies(manychat_page_id) WHERE manychat_page_id IS NOT NULL;
