-- Migration: 034_messages_audio_fields
-- Add audio-related columns to chat_messages for voice message support

ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS has_audio BOOLEAN DEFAULT FALSE;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS audio_url TEXT;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS audio_duration_seconds INTEGER;

-- Optional: allow chat_conversations to be per-lead for voice/inbox flows
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS lead_id UUID REFERENCES leads(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_chat_conversations_lead
  ON chat_conversations(lead_id) WHERE lead_id IS NOT NULL;
