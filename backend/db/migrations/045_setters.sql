CREATE TABLE IF NOT EXISTS team_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  role VARCHAR(30) DEFAULT 'setter',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS setter_performance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  setter_id UUID REFERENCES team_members(id) ON DELETE SET NULL,
  setter_name VARCHAR(255),
  date DATE NOT NULL,
  conversations_handled INTEGER DEFAULT 0,
  replies_sent INTEGER DEFAULT 0,
  leads_qualified INTEGER DEFAULT 0,
  calls_booked INTEGER DEFAULT 0,
  deals_closed INTEGER DEFAULT 0,
  revenue_attributed NUMERIC(10,2) DEFAULT 0,
  avg_response_time_minutes INTEGER DEFAULT 0,
  UNIQUE(company_id, setter_id, date)
);

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS assigned_setter_id UUID REFERENCES team_members(id) ON DELETE SET NULL;
