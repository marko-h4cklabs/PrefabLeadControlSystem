-- Pre-call warming and no-show reduction: sequences, steps, enrollments, message log

CREATE TABLE IF NOT EXISTS warming_sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  trigger_event VARCHAR(50) NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS warming_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id UUID NOT NULL REFERENCES warming_sequences(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  delay_minutes INTEGER NOT NULL,
  message_template TEXT NOT NULL,
  step_type VARCHAR(30) DEFAULT 'message',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS warming_enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  sequence_id UUID NOT NULL REFERENCES warming_sequences(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  enrolled_at TIMESTAMP DEFAULT NOW(),
  current_step INTEGER DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active',
  completed_at TIMESTAMP DEFAULT NULL,
  cancelled_at TIMESTAMP DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS warming_message_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id UUID NOT NULL REFERENCES warming_enrollments(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  step_id UUID NOT NULL REFERENCES warming_steps(id) ON DELETE CASCADE,
  message_sent TEXT NOT NULL,
  sent_at TIMESTAMP DEFAULT NOW(),
  manychat_response JSONB
);

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS no_show_risk_score INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_engagement_at TIMESTAMP DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_warming_sequences_company_trigger ON warming_sequences(company_id, trigger_event);
CREATE INDEX IF NOT EXISTS idx_warming_steps_sequence_order ON warming_steps(sequence_id, step_order);
CREATE INDEX IF NOT EXISTS idx_warming_enrollments_lead_status ON warming_enrollments(lead_id, status);
CREATE INDEX IF NOT EXISTS idx_warming_enrollments_company ON warming_enrollments(company_id, status);
