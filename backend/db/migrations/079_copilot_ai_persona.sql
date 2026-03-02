-- AI persona generation feature for copilot mode
-- Stores the AI-generated persona snapshot alongside manual settings
ALTER TABLE chatbot_behavior
  ADD COLUMN IF NOT EXISTS copilot_persona_source TEXT DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS ai_persona_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS ai_persona_generated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ai_persona_summary TEXT;
