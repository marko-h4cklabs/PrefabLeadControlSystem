-- Add configurable ambient background noise for voice messages (e.g. 'restaurant')
ALTER TABLE companies ADD COLUMN IF NOT EXISTS voice_ambient_noise VARCHAR DEFAULT NULL;
