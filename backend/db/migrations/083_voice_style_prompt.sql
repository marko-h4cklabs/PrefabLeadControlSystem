-- Add voice_style_prompt for controlling how TTS voice notes should sound
ALTER TABLE companies ADD COLUMN IF NOT EXISTS voice_style_prompt TEXT DEFAULT '';
