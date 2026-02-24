-- Per-company ManyChat, webhook token, onboarding. Self-service architecture.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS manychat_api_key TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS manychat_page_id TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS manychat_connected BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS onboarding_step INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS webhook_token TEXT DEFAULT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_webhook_token ON companies(webhook_token) WHERE webhook_token IS NOT NULL;

-- Generate webhook_token for existing companies that don't have one
UPDATE companies
SET webhook_token = encode(gen_random_bytes(32), 'hex')
WHERE webhook_token IS NULL;

CREATE INDEX IF NOT EXISTS idx_companies_manychat_page_id
  ON companies(manychat_page_id) WHERE manychat_page_id IS NOT NULL;
