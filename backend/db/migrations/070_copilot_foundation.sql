-- Co-Pilot mode foundation: kill switch, lead assignment, mode-scoped settings, team metrics

-- 1. Kill switch: master ON/OFF for AI processing
ALTER TABLE companies ADD COLUMN IF NOT EXISTS bot_enabled BOOLEAN DEFAULT true;

-- 2. Lead assignment to setters
ALTER TABLE leads ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES users(id);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_leads_assigned_to ON leads(assigned_to) WHERE assigned_to IS NOT NULL;

-- 3. Mode-scoped AI settings
ALTER TABLE chatbot_behavior ADD COLUMN IF NOT EXISTS operating_mode VARCHAR(20) DEFAULT 'autopilot';
ALTER TABLE chatbot_company_info ADD COLUMN IF NOT EXISTS operating_mode VARCHAR(20) DEFAULT 'autopilot';
ALTER TABLE chatbot_personas ADD COLUMN IF NOT EXISTS operating_mode VARCHAR(20) DEFAULT 'autopilot';
ALTER TABLE chatbot_quote_fields ADD COLUMN IF NOT EXISTS operating_mode VARCHAR(20) DEFAULT 'autopilot';

-- Re-scope unique constraints to include operating_mode
-- chatbot_behavior: allow one row per (company, mode)
DO $$
BEGIN
  -- Drop old unique if it exists (may be named differently across migrations)
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chatbot_behavior_company_id_key') THEN
    ALTER TABLE chatbot_behavior DROP CONSTRAINT chatbot_behavior_company_id_key;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chatbot_behavior_company_mode
  ON chatbot_behavior(company_id, COALESCE(operating_mode, 'autopilot'));

-- chatbot_company_info: allow one row per (company, mode)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chatbot_company_info_company_id_key') THEN
    ALTER TABLE chatbot_company_info DROP CONSTRAINT chatbot_company_info_company_id_key;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chatbot_company_info_company_mode
  ON chatbot_company_info(company_id, COALESCE(operating_mode, 'autopilot'));

-- 4. Reply suggestions: track which setter acted and edited text
ALTER TABLE reply_suggestions ADD COLUMN IF NOT EXISTS acted_by UUID REFERENCES users(id);
ALTER TABLE reply_suggestions ADD COLUMN IF NOT EXISTS edited_text TEXT;

-- 5. Team performance tracking
CREATE TABLE IF NOT EXISTS setter_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  company_id UUID NOT NULL REFERENCES companies(id),
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  dms_handled INT DEFAULT 0,
  suggestions_sent INT DEFAULT 0,
  suggestions_edited INT DEFAULT 0,
  custom_replies INT DEFAULT 0,
  avg_response_seconds INT DEFAULT 0,
  leads_qualified INT DEFAULT 0,
  UNIQUE(user_id, date)
);
CREATE INDEX IF NOT EXISTS idx_setter_metrics_company_date ON setter_metrics(company_id, date);

-- 6. Notification types for copilot
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
-- Re-add with expanded types (if check constraint exists, this is a no-op)
DO $$
BEGIN
  ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
    CHECK (type IN (
      'new_lead', 'new_message', 'booking_confirmed', 'booking_cancelled',
      'deal_logged', 'ai_error', 'message_limit_warning', 'trial_ending',
      'hot_lead', 'autoresponder',
      'copilot_new_dm', 'copilot_hot_lead', 'copilot_stale_dm', 'copilot_assignment'
    ));
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
