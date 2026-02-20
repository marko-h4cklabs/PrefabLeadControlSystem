-- Add source column to leads: real (from integrations) vs simulation (manual/test)
-- Migration: 018_leads_source

-- 1) Add source column with default (existing rows get 'simulation')
ALTER TABLE leads ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'simulation';
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_source_check;
ALTER TABLE leads ADD CONSTRAINT leads_source_check CHECK (source IN ('real', 'simulation'));

-- 2) Backfill existing rows (in case column existed without default)
UPDATE leads SET source = 'simulation' WHERE source IS NULL OR source NOT IN ('real', 'simulation');

-- 3) Drop old unique, add new one including source (allows same external_id for real vs simulation)
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_company_id_channel_external_id_key;
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_company_channel_external_source_key;
ALTER TABLE leads ADD CONSTRAINT leads_company_channel_external_source_key
  UNIQUE (company_id, channel, external_id, source);

-- 4) Index for listing by source
CREATE INDEX IF NOT EXISTS idx_leads_company_source_created
  ON leads (company_id, source, created_at DESC);
