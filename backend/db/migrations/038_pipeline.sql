-- Migration 038: Pipeline fields on leads and pipeline_stage_history table (idempotent)

-- Pipeline stage history: one row per stage change per lead
CREATE TABLE IF NOT EXISTS pipeline_stage_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  pipeline_stage VARCHAR(50) NOT NULL,
  deal_value NUMERIC(10,2) DEFAULT NULL,
  changed_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pipeline_stage_history_lead_id ON pipeline_stage_history(lead_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_stage_history_company_id ON pipeline_stage_history(company_id);

-- Lead pipeline and close fields
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS pipeline_stage VARCHAR(50) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS pipeline_moved_at TIMESTAMP DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS deal_value NUMERIC(10,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS lost_reason TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS pipeline_notes TEXT DEFAULT NULL;
