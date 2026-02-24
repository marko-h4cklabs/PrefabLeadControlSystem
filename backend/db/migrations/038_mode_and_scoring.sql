-- Migration 038: Operating mode (autopilot/copilot), lead intelligence, reply suggestions, hot lead alerts

-- Company operating mode
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS operating_mode VARCHAR(20) DEFAULT NULL;
-- 'autopilot' = AI sends replies automatically (current behavior)
-- 'copilot' = AI suggests replies, human sends them

-- Lead scoring and intelligence
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS intent_score INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS intent_tags TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS budget_detected VARCHAR(255) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS urgency_level VARCHAR(20) DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS conversation_summary TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS summary_updated_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS is_hot_lead BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS hot_lead_triggered_at TIMESTAMPTZ DEFAULT NULL;

-- Suggested replies table (conversations = lead-scoped chat in this schema)
CREATE TABLE IF NOT EXISTS reply_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  suggestions JSONB NOT NULL DEFAULT '[]',
  context_snapshot TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  used_suggestion_index INTEGER DEFAULT NULL,
  used_at TIMESTAMPTZ DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_reply_suggestions_lead_id ON reply_suggestions(lead_id);
CREATE INDEX IF NOT EXISTS idx_reply_suggestions_conversation_id ON reply_suggestions(conversation_id);

-- Hot lead alerts log
CREATE TABLE IF NOT EXISTS hot_lead_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  trigger_reason TEXT,
  intent_score INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  dismissed_at TIMESTAMPTZ DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_hot_lead_alerts_company_dismissed ON hot_lead_alerts(company_id, dismissed_at);
CREATE INDEX IF NOT EXISTS idx_hot_lead_alerts_lead_id ON hot_lead_alerts(lead_id);
