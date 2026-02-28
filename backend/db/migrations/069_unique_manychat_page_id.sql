-- Prevent multiple companies from sharing the same ManyChat page_id.
-- This caused webhook routing collisions where messages were processed
-- with the wrong company's settings (wrong persona, voice config, quote fields, etc).
-- NULLs are excluded so disconnected companies don't conflict.

CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_manychat_page_id_unique
  ON companies (manychat_page_id)
  WHERE manychat_page_id IS NOT NULL;
