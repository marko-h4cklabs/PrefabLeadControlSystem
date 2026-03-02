-- Add conversation approach mode: field_focused (default) vs rapport_building
ALTER TABLE chatbot_behavior ADD COLUMN IF NOT EXISTS conversation_approach VARCHAR(50) DEFAULT 'field_focused';

-- Add standalone no-trailing-period toggle (independent of human_error_enabled)
ALTER TABLE chatbot_behavior ADD COLUMN IF NOT EXISTS no_trailing_period BOOLEAN DEFAULT FALSE;
