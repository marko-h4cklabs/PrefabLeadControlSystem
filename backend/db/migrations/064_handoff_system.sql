-- Human-Break / Handoff System
-- Per-conversation bot pause + handoff rules engine + handoff logging

-- 1. Add pause state to conversations
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS bot_paused BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paused_reason TEXT,
  ADD COLUMN IF NOT EXISTS paused_by VARCHAR(20) DEFAULT NULL;

-- 2. Add auto-resume config to chatbot_behavior
ALTER TABLE chatbot_behavior
  ADD COLUMN IF NOT EXISTS auto_resume_minutes INTEGER DEFAULT 30,
  ADD COLUMN IF NOT EXISTS handoff_bridging_message TEXT DEFAULT NULL;

-- 3. Handoff rules table
CREATE TABLE IF NOT EXISTS handoff_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  rule_type VARCHAR(30) NOT NULL,
  trigger_value TEXT NOT NULL,
  action VARCHAR(30) DEFAULT 'pause_and_notify',
  bridging_message TEXT DEFAULT NULL,
  is_active BOOLEAN DEFAULT true,
  priority INTEGER DEFAULT 100,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_handoff_rules_company ON handoff_rules(company_id, is_active);

-- 4. Handoff log table
CREATE TABLE IF NOT EXISTS handoff_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  rule_id UUID REFERENCES handoff_rules(id) ON DELETE SET NULL,
  trigger_reason TEXT,
  paused_at TIMESTAMPTZ DEFAULT NOW(),
  resumed_at TIMESTAMPTZ,
  resumed_by VARCHAR(30),
  owner_response_time_seconds INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_handoff_log_company ON handoff_log(company_id);
CREATE INDEX IF NOT EXISTS idx_handoff_log_lead ON handoff_log(lead_id);
