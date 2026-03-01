-- Master toggle to enable/disable all follow-up processing
ALTER TABLE chatbot_behavior ADD COLUMN IF NOT EXISTS follow_ups_enabled BOOLEAN DEFAULT TRUE;
