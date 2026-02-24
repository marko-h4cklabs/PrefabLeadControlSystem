-- chatbot_behavior: ensure updated_at exists (for dynamic upsert). company_id is already PRIMARY KEY so ON CONFLICT works.
ALTER TABLE chatbot_behavior
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
