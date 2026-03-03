-- Migration 080: Named AI Persona Templates
-- Creates a table to store named AI persona snapshots per company
-- and adds a foreign key on chatbot_behavior to track which is active

CREATE TABLE IF NOT EXISTS copilot_ai_personas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  snapshot JSONB NOT NULL DEFAULT '{}',
  style_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_copilot_ai_personas_company_id ON copilot_ai_personas(company_id);

-- Add active_ai_persona_id to chatbot_behavior
ALTER TABLE chatbot_behavior
  ADD COLUMN IF NOT EXISTS active_ai_persona_id UUID REFERENCES copilot_ai_personas(id) ON DELETE SET NULL;
