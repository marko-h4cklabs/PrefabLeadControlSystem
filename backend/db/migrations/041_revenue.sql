-- Revenue tracking and attribution: deals, revenue_snapshots, lead attribution and pipeline fields

CREATE TABLE IF NOT EXISTS deals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  amount NUMERIC(10,2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'EUR',
  status VARCHAR(20) DEFAULT 'won',
  closed_at TIMESTAMP DEFAULT NOW(),
  notes TEXT,
  attribution_source TEXT,
  attribution_campaign TEXT,
  setter_name TEXT,
  closer_name TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS revenue_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  total_revenue NUMERIC(12,2) DEFAULT 0,
  deals_count INTEGER DEFAULT 0,
  leads_count INTEGER DEFAULT 0,
  conversations_count INTEGER DEFAULT 0,
  hot_leads_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(company_id, snapshot_date)
);

CREATE TABLE IF NOT EXISTS pipeline_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  pipeline_stage VARCHAR(50) NOT NULL,
  deal_value NUMERIC(10,2) DEFAULT NULL,
  changed_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS source_content TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS source_campaign TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS assigned_setter TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS assigned_closer TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS pipeline_stage VARCHAR(50) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS deal_value NUMERIC(10,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_deals_company_closed ON deals(company_id, closed_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_deals_lead ON deals(lead_id);
CREATE INDEX IF NOT EXISTS idx_revenue_snapshots_company_date ON revenue_snapshots(company_id, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_pipeline_history_lead ON pipeline_history(lead_id, changed_at);
