-- Add source column to leads: inbox (real) vs simulation (manual/test)
-- Migration: 018_leads_add_source

-- 1) Add source column with default (existing rows get 'inbox')
ALTER TABLE leads ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'inbox';

-- 2) Migrate legacy 'real' to 'inbox' (if previous migration used real|simulation)
UPDATE leads SET source = 'inbox' WHERE source = 'real' OR source IS NULL OR source NOT IN ('inbox', 'simulation');

-- 3) Check constraint: inbox|simulation only
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_source_check;
ALTER TABLE leads ADD CONSTRAINT leads_source_check CHECK (source IN ('inbox', 'simulation'));

-- 4) Drop old unique if exists, add new one including source
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_company_id_channel_external_id_key;
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_company_channel_external_source_key;
ALTER TABLE leads ADD CONSTRAINT leads_company_channel_external_source_key
  UNIQUE (company_id, channel, external_id, source);

-- 5) Indexes for listing by source
CREATE INDEX IF NOT EXISTS idx_leads_company_source_created
  ON leads (company_id, source, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_company_source_name
  ON leads (company_id, source, name);
