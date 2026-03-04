-- Add operating_mode to message_templates so copilot can have its own templates
ALTER TABLE message_templates ADD COLUMN IF NOT EXISTS operating_mode VARCHAR(20) DEFAULT 'autopilot';

CREATE INDEX IF NOT EXISTS idx_message_templates_company_mode
  ON message_templates(company_id, COALESCE(operating_mode, 'autopilot'));
