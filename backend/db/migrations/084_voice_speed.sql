-- Add voice_speed to control TTS speaking rate (ElevenLabs speed param: 0.25-4.0, default 1.0)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS voice_speed NUMERIC DEFAULT 1.0;
