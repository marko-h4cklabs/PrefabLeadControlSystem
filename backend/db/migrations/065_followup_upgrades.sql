-- Advanced Follow-Up System Upgrades
-- AI-generated follow-ups, branching conditions, smart timing, escalation, analytics

-- 1. Add conditions and AI support to warming steps
ALTER TABLE warming_steps
  ADD COLUMN IF NOT EXISTS conditions JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS ai_context_prompt TEXT DEFAULT NULL;

-- 2. Add smart timing and tracking to enrollments
ALTER TABLE warming_enrollments
  ADD COLUMN IF NOT EXISTS next_send_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS follow_ups_sent INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paused BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS escalated BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS escalation_action VARCHAR(30) DEFAULT NULL;

-- 3. Add reply tracking to message log
ALTER TABLE warming_message_log
  ADD COLUMN IF NOT EXISTS lead_replied BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS reply_sentiment VARCHAR(20) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ DEFAULT NULL;

-- 4. Add configurable no-reply delay and escalation settings
ALTER TABLE warming_sequences
  ADD COLUMN IF NOT EXISTS no_reply_delay_hours INTEGER DEFAULT 72,
  ADD COLUMN IF NOT EXISTS max_follow_ups INTEGER DEFAULT 5,
  ADD COLUMN IF NOT EXISTS escalation_action VARCHAR(30) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS escalation_value TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS category VARCHAR(30) DEFAULT 'general';

-- 5. Follow-up analytics table
CREATE TABLE IF NOT EXISTS follow_up_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sequence_id UUID NOT NULL REFERENCES warming_sequences(id) ON DELETE CASCADE,
  period_date DATE NOT NULL,
  messages_sent INTEGER DEFAULT 0,
  replies_received INTEGER DEFAULT 0,
  positive_replies INTEGER DEFAULT 0,
  negative_replies INTEGER DEFAULT 0,
  escalations INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_followup_analytics_unique
  ON follow_up_analytics(company_id, sequence_id, period_date);
CREATE INDEX IF NOT EXISTS idx_followup_analytics_company
  ON follow_up_analytics(company_id, period_date);
