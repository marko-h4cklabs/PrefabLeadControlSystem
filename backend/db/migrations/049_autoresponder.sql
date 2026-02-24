CREATE TABLE IF NOT EXISTS autoresponder_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  trigger_type VARCHAR(30) NOT NULL,
  trigger_value TEXT,
  action_type VARCHAR(30) NOT NULL,
  action_value TEXT,
  is_active BOOLEAN DEFAULT true,
  priority INTEGER DEFAULT 0,
  match_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_autoresponder_rules_company_active ON autoresponder_rules(company_id, is_active);
