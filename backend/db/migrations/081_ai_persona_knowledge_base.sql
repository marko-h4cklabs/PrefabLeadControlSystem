-- Migration 081: Add knowledge_base column to copilot_ai_personas
-- Stores AI-extracted insights, client patterns, objections, and key context
-- from uploaded conversation files and images.

ALTER TABLE copilot_ai_personas
  ADD COLUMN IF NOT EXISTS knowledge_base TEXT;
