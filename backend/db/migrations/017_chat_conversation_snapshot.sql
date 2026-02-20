-- Add settings_snapshot to conversations (quote_snapshot already exists from 014)
-- Migration: 017_chat_conversation_snapshot

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS settings_snapshot JSONB;

-- Backfill: existing conversations with quote_snapshot but no settings_snapshot get default
UPDATE conversations
SET settings_snapshot = '{"tone":"professional","response_length":"medium","persona_style":"busy","forbidden_topics":[]}'::jsonb
WHERE settings_snapshot IS NULL AND quote_snapshot IS NOT NULL;
