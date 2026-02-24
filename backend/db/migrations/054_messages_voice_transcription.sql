-- Voice message support: is_voice and transcription on chat_messages
-- Migration: 054_messages_voice_transcription
-- (audio_url already added in 034)

ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS is_voice BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS transcription TEXT DEFAULT NULL;
