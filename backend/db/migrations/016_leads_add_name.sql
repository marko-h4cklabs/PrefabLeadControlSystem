-- Add leads.name column, backfill from external_id, add index
-- Migration: 016_leads_add_name

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS name TEXT;

UPDATE leads
SET name = external_id
WHERE name IS NULL;

CREATE INDEX IF NOT EXISTS leads_company_id_name_idx
  ON leads(company_id, name);
